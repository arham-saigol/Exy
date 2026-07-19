# Install Exy on Ubuntu

## Supported environment

- Ubuntu 22.04 LTS or 24.04 LTS
- `amd64` or `arm64`
- systemd as PID 1
- outbound HTTPS access to Discord, OpenAI, OpenCode Go, Supermemory, Xquik, Zernio, Exa, npm, and GitHub when installing skills
- Node.js 22.19.0 or newer; the current pinned Pi packages declare this minimum

The application is intended for one VPS and one gateway process. SQLite is a good fit for this topology. Running multiple gateway replicas against the same database is not a supported high-availability design, although scheduler leases and verifier uniqueness still protect their individual invariants.

## 1. Prepare provider and Discord accounts

Have these values ready:

- Discord bot token, application/client ID, and authorized user ID
- Supermemory API key
- Xquik API key
- Zernio API key, with the intended X account already connected
- Exa API key

Complete the Discord steps in [DISCORD.md](DISCORD.md), including Message Content Intent. Complete provider setup in [PROVIDERS.md](PROVIDERS.md).

The selected skills.sh workflow installs public repositories directly into `.agents/skills`, so normal setup does not ask for a GitHub token. Private-repository access is left to an operator-managed SSH or GitHub CLI login.

## 2. Place and build the application

Keep application code outside home directories because the systemd unit enables `ProtectHome=true`.

```bash
sudo install -d -m 0755 /opt/exy
sudo git clone <repository-url> /opt/exy
cd /opt/exy
```

Bootstrap the host. The script installs `ca-certificates`, `curl`, `git`, and `xz-utils`.
If Node is missing, older than 22.19, or resolves below `/root` or `/home`, it downloads
the current official Node 22 `amd64`/`arm64` archive from `nodejs.org`, verifies
`SHASUMS256.txt`, installs it below `/usr/local/lib/nodejs`, and creates
`/usr/local/bin` links. A home-managed Node runtime is intentionally replaced because
the hardened service cannot read home directories.

```bash
sudo bash scripts/bootstrap-ubuntu.sh
node --version
```

Install, verify, build, and expose the CLI globally:

```bash
sudo npm ci
sudo npm run check
sudo npm run build
sudo npm install --global . --prefix /usr/local
exy help
```

The explicit `/usr/local` prefix keeps the `exy` binary on Ubuntu's normal administrative
`PATH` even though the bootstrap installs Node below `/usr/local/lib/nodejs`.
`npm install --global . --prefix /usr/local` packages the built `dist` tree, bundled
automation skill, heartbeat template, and documentation. It does not put configuration
or secrets in the source repository.

## 3. Run the idempotent setup wizard

```bash
sudo exy setup
```

The wizard:

1. Detects missing runtime utilities and installs them with `apt-get` when necessary.
2. Creates `/etc/exy`, `/var/lib/exy`, the workspace, sessions, Pi auth directory, and `.agents/skills` with restrictive permissions.
3. Prompts for the Discord and provider credentials.
4. Calls Zernio's connected-account list and requires selection of a healthy `twitter` account.
5. Explains that Zernio X analytics can incur pass-through X API charges and asks before enabling that capability.
6. Stores secrets separately, writes the non-secret configuration, installs a dedicated `exy` system user, installs/enables `exy.service`, and reloads systemd.

Rerunning setup preserves the prior model preference and heartbeat configuration. Blank
secret answers keep existing secrets. It does not start the gateway; if the service was
already running, the final report tells you to restart it so changed configuration takes
effect.

If the Discord application, authorized user, or connected X
account changes, setup disables heartbeat and clears its delivery thread. Re-enable it
from a newly created in-scope Exy thread after restarting.

The setup wizard itself is a Node program, so a usable Node runtime must exist before `exy setup` can execute; that is the sole purpose of the bootstrap step.

## 4. Configure Pi providers

Run login once for each provider you need:

```bash
sudo exy login
```

The first prompt chooses **OpenCode Go** or **ChatGPT/Codex**.

For ChatGPT/Codex, Exy keeps the existing headless flow: Pi's native OAuth provider selects device-code login, displays the OpenAI verification URL/code, polls, refreshes, and stores the credential. You then select the main coordinator model and its Pi-supported reasoning level.

For OpenCode Go, Exy asks for the API key with masked input, fetches the current public model catalog from OpenCode Go, validates the key with a minimal request through Pi's native `opencode-go` provider, displays every returned model, and asks which supported model should run the writing subagent. Kimi K3 is marked as recommended and becomes the default selection when the provider exposes it, but any currently selectable Pi/OpenCode Go model may be chosen. The writing preference persists independently from the main model.

New installations can configure only OpenCode Go; if no main model exists, Exy also uses the selected Go model for the coordinator/research role. Existing Codex installations keep their OAuth credential and main model when OpenCode Go is added. They can still start after upgrading, but doctor warns and draft requests fail clearly until OpenCode Go is configured; no repeat Codex login is required. Pi performs provider-scoped credential updates, so neither path logs out the other. To change one provider later, rerun `exy login` and choose it again.

Clear failures are reported for invalid keys, provider errors, empty model lists, and stale writing selections. A provider model newer than the installed Pi catalog is displayed as unavailable until Exy/Pi is upgraded rather than being silently substituted.

The Exa check performs a one-result search because Exa has no documented free core-auth endpoint; it may consume a small amount of Exa usage.

## 5. Diagnose and start

```bash
sudo exy doctor
sudo exy start
sudo exy status
sudo exy logs -f
```

`doctor` checks:

- Node and command dependencies
- configuration and secret-file permissions
- writable data/workspace/session/skill paths
- configured Pi credentials, the main model/reasoning pair, and the OpenCode Go writing model
- Discord token and Message Content application flag
- Discord authorized user identity
- Supermemory, Xquik, Zernio, and Exa connectivity
- installed and active systemd state

An inactive but correctly installed service is a warning. Configuration, auth, path, or provider failures return a nonzero exit code.

## Filesystem and service layout

| Path | Purpose | Expected access |
| --- | --- | --- |
| `/opt/exy` | source checkout used for updates | root-managed, service read-only |
| `/etc/exy/config.json` | Discord application/user IDs, selected X account, model, heartbeat settings | mode `0600` |
| `/etc/exy/secrets.json` | Discord/provider API keys | mode `0600`; never logged |
| `/var/lib/exy/exy.sqlite` | verifier, drafts, threads, schedules, histories | mode `0600`, WAL enabled |
| `/var/lib/exy/pi-agent/auth.json` | Pi provider-scoped Codex OAuth and OpenCode Go credentials | Pi writes mode `0600` |
| `/var/lib/exy/sessions/` | separate Pi JSONL session per Discord thread | mode `0700` directory |
| `/var/lib/exy/workspace/HEARTBEAT.md` | live heartbeat checklist | mode `0600`, comments-only initially |
| `/var/lib/exy/workspace/.agents/skills/` | live open Agent Skills | mode `0700` tree |
| journald unit `exy.service` | stdout/stderr logs | read through `exy logs` |

The systemd unit uses `User=exy`, `UMask=0077`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, explicit writable configuration/state paths, network-online ordering, and `Restart=on-failure`.

## Installation success criteria

The install is ready when:

```bash
sudo exy doctor
sudo exy start
sudo exy status
```

show no blocking doctor failures and an active service, and a mention by the configured
user in a server text channel creates an `Exy · …` thread and receives a response.
