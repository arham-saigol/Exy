# Exy

Exy is a self-hosted specialist agent for sustainable X/Twitter growth. It runs as a Discord bot on an Ubuntu VPS and uses Pi for a coordinator plus focused research and writing subagents. It supports ChatGPT/Codex and OpenCode Go credentials while exposing narrow tools for X research, web research, memory, publishing, analytics, skills, heartbeat work, and scheduled work.

## What is implemented

- Pi `0.80.10` native providers: headless ChatGPT/Codex device-code OAuth and OpenCode Go API-key auth; no custom provider or OAuth flow.
- A lean main coordinator that delegates substantial research to same-model research subagents and every reply/original-post draft to a user-selected OpenCode Go writing subagent.
- Live OpenCode Go model discovery, Kimi K3 as the recommended writing default when available, and persisted main/writing model preferences.
- Discord mention-to-public-thread routing with one durable Pi conversation per thread.
- Supermemory isolation by configured Discord user plus connected Zernio X account.
- Xquik raw candidate search and a persistent, canonical-ID reply recommendation verifier.
- Zernio content validation and exact one-time publication of conversation drafts, replies, and original posts.
- Read-only Zernio analytics.
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
sudo exy login  # choose ChatGPT/Codex for the coordinator, if needed
sudo exy login  # choose OpenCode Go and the writing model
sudo exy doctor
sudo exy start
```

If the repository is already present at `/opt/exy`, omit the clone step. The bootstrap installs an official Node 22 binary only when the installed Node is too old, and verifies its published SHA-256 checksum. `exy setup` then detects and installs missing Ubuntu runtime utilities, creates the service user and data layout, and installs the systemd unit.

Before setup, create the provider accounts/API keys and connect the intended X account in Zernio. See [installation](docs/INSTALL.md), [provider setup](docs/PROVIDERS.md), and [Discord setup](docs/DISCORD.md).

## Agent roles

The main agent coordinates the conversation, quick lookups, tools, and publication transaction. Research-heavy work runs in an ephemeral research subagent that inherits the coordinator's active model and reasoning and can search X and the web repeatedly. Every reply and original post runs through an ephemeral writing subagent using the persisted OpenCode Go model. The writing tool saves the exact returned bytes before the coordinator can show them, so the coordinator cannot bypass the writer by saving its own copy.

Installed Agent Skills are available to both child roles through Exy's confined skill tools. The bundled writing and X-algorithm skills are installed non-destructively during setup.

## Publishing safety

Publishing requires one explicit user instruction after a draft exists:

1. Exy saves the exact original post or reply it presents as the current draft for that Discord conversation. Drafting never publishes.
2. The authorized user says `post this`, `publish this draft`, or gives an equivalent clear instruction. Exy validates and publishes that exact stored draft in the same turn, without another confirmation or a user-facing ID.

Ambiguous references require clarification. General strategy instructions, schedules, heartbeats, and instructions about another draft cannot authorize publication. Set `EXY_DRY_RUN=1` in a systemd override to exercise the complete flow without calling Zernio's publish endpoint.

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

## Model discovery notes

Exy does not hard-code selectable model IDs. Codex choices come from Pi's authenticated native catalog. OpenCode Go login fetches the provider's current `/models` response, validates the submitted key with a minimal request through Pi's native `opencode-go` provider, and intersects the live Go catalog with models supported by the installed Pi release. It displays provider models that the current Pi version cannot yet run instead of silently selecting them. See [research notes](docs/RESEARCH.md#pi-runtime-oauth-models-and-reasoning).

## License

MIT
