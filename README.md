# Exy

Exy is a self-hosted specialist agent for sustainable X/Twitter growth. It runs as a Discord bot on an Ubuntu VPS, uses Pi for the agent runtime and ChatGPT Plus/Pro Codex authentication, and exposes narrow tools for X research, web research, memory, publishing, analytics, skills, heartbeat work, and scheduled work.

## What is implemented

- Pi `0.80.6` device-code OAuth for a headless VPS; no custom OAuth flow.
- Pi-sourced OpenAI Codex model selection and Pi-sourced reasoning levels, persisted across restarts.
- Discord mention-to-public-thread routing with one durable Pi conversation per thread.
- Supermemory isolation by configured Discord user plus connected Zernio X account.
- Xquik raw candidate search and a persistent, canonical-ID reply recommendation verifier.
- Zernio content validation, exact one-time publication approvals, replies, original posts, and analytics.
- Exa search and page fetching.
- SQLite-backed schedules, execution leases/history, heartbeat execution, and open Agent Skills discovery.
- An idempotent Ubuntu setup wizard and lifecycle CLI backed by systemd.
- A mocked provider test path plus `EXY_DRY_RUN=1`, so tests never publish to X.

Exy never treats an accepted provider request as proof of publication. It reports success only when Zernio returns `published` for the requested X account target.

## Quick start on Ubuntu

Supported deployment target: Ubuntu 22.04 or 24.04 on `amd64` or `arm64`, with systemd. Exy and its pinned Pi SDK require Node.js 22.19 or newer.

```bash
sudo install -d -m 0755 /opt/exy
sudo git clone <repository-url> /opt/exy
cd /opt/exy

sudo bash scripts/bootstrap-ubuntu.sh
sudo npm ci
sudo npm run build
sudo npm install --global . --prefix /usr/local

sudo exy setup
sudo exy login
sudo exy doctor
sudo exy start
```

If the repository is already present at `/opt/exy`, omit the clone step. The bootstrap installs an official Node 22 binary only when the installed Node is too old, and verifies its published SHA-256 checksum. `exy setup` then detects and installs missing Ubuntu runtime utilities, creates the service user and data layout, and installs the systemd unit.

Before setup, create the provider accounts/API keys and connect the intended X account in Zernio. See [installation](docs/INSTALL.md), [provider setup](docs/PROVIDERS.md), and [Discord setup](docs/DISCORD.md).

## Publishing safety

Publishing is deliberately two-step:

1. Exy validates and prepares an immutable original post or reply. It shows the exact content, target, expiry, and an `EXY_APPROVAL:…` code.
2. The authorized user sends `approve EXY_APPROVAL:…` in a later message. Only then can the exact stored payload be consumed once and sent to Zernio.

General strategy instructions, schedules, heartbeats, and approval of another draft cannot authorize publication. Set `EXY_DRY_RUN=1` in a systemd override to exercise the complete approval path without calling Zernio's publish endpoint.

## CLI

```text
exy setup
exy login
exy start
exy stop
exy restart
exy status
exy logs [-f]
exy doctor
exy help
```

Discord registers only `/model`, `/reasoning`, `/restart`, and `/interrupt`.

## Documentation

- [Install on Ubuntu](docs/INSTALL.md)
- [Configure providers](docs/PROVIDERS.md)
- [Configure Discord](docs/DISCORD.md)
- [Operate, update, back up, and recover Exy](docs/OPERATIONS.md)
- [Heartbeat, schedules, and Agent Skills](docs/AUTOMATION_AND_SKILLS.md)
- [Architecture, state isolation, and safety boundaries](docs/ARCHITECTURE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Primary documentation researched for this implementation](docs/RESEARCH.md)

## Development and verification

```bash
npm ci
npm run check
npm run build
npm audit --omit=dev
```

The test suite uses injected `fetch` implementations and temporary SQLite databases. It never calls real publish endpoints. The reply verifier tests cover duplicate URLs, alternate X/Twitter URL forms, scope isolation, and database restarts.

## Upstream Pi model-list limitation

Exy does not contain model IDs. After OAuth it asks Pi's `ModelRegistry` for the OpenAI Codex models exposed by the installed Pi release and uses `getSupportedThinkingLevels()` for the selected model.

Pi currently ships the Codex catalog with each Pi release; its `openai-codex` provider does not implement remote account-entitlement enumeration. Therefore the UI accurately calls these “models exposed by Pi,” not “models verified against this account.” OpenAI can still reject a listed model on first use. Probing every model would consume subscription usage and is not a supported discovery API. See [research notes](docs/RESEARCH.md#pi-runtime-oauth-models-and-reasoning).

## License

MIT
