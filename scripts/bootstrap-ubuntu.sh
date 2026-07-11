#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this bootstrap with sudo/root." >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]] || ! grep -q '^ID=ubuntu' /etc/os-release; then
  echo "This bootstrap supports Ubuntu only." >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git xz-utils

node_ok=false
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then
  node_version="$(node -p 'process.versions.node.split(".").map(Number).slice(0,2).join(".")')"
  node_path="$(readlink -f "$(command -v node)")"
  node_major="${node_version%%.*}"
  node_minor="${node_version#*.}"
  if (( node_major > 22 || (node_major == 22 && node_minor >= 19) )); then
    case "${node_path}" in
      /root/*|/home/*) node_ok=false ;;
      *) node_ok=true ;;
    esac
  fi
fi

if [[ "${node_ok}" != true ]]; then
  case "$(dpkg --print-architecture)" in
    amd64) node_arch="x64" ;;
    arm64) node_arch="arm64" ;;
    *) echo "Supported VPS architectures are amd64 and arm64." >&2; exit 1 ;;
  esac

  temp_dir="$(mktemp -d /tmp/exy-node.XXXXXX)"
  trap 'rm -rf -- "${temp_dir}"' EXIT
  cd "${temp_dir}"
  curl --fail --show-error --silent --location \
    https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
  archive="$(awk -v arch="${node_arch}" '$2 ~ ("node-v[0-9.]+-linux-" arch "\\.tar\\.xz$") { print $2; exit }' SHASUMS256.txt)"
  if [[ -z "${archive}" ]]; then
    echo "Could not identify the current official Node 22 archive." >&2
    exit 1
  fi
  curl --fail --show-error --location "https://nodejs.org/dist/latest-v22.x/${archive}" -o "${archive}"
  grep " ${archive}$" SHASUMS256.txt | sha256sum --check --strict

  install_root="/usr/local/lib/nodejs/${archive%.tar.xz}"
  install -d -m 0755 /usr/local/lib/nodejs
  tar -xJf "${archive}" -C /usr/local/lib/nodejs
  ln -sfn "${install_root}/bin/node" /usr/local/bin/node
  ln -sfn "${install_root}/bin/npm" /usr/local/bin/npm
  ln -sfn "${install_root}/bin/npx" /usr/local/bin/npx
  if [[ -x "${install_root}/bin/corepack" ]]; then
    ln -sfn "${install_root}/bin/corepack" /usr/local/bin/corepack
  fi
  hash -r
fi

echo "Ubuntu bootstrap complete: $(node --version), npm $(npm --version)"
