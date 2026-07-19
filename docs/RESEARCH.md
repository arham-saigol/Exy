# Primary documentation and implementation decisions

This implementation was researched against primary documentation on 2026-07-11. APIs,
catalogs, and limits can change; the pinned package lock and the linked provider pages
together define the supported snapshot.

## Pi runtime, OAuth, models, and reasoning

Exy pins these current Pi packages at `0.80.10`:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai`

Their package metadata requires Node.js 22.19 or newer. Pi's
[source repository](https://github.com/earendil-works/pi) documents the coding-agent SDK,
custom tools, sessions, authentication storage, and model registry.

The `openai-codex` OAuth provider implements both browser callback and device-code
methods. Exy calls `ModelRuntime.login("openai-codex", "oauth", interaction)` and selects
the provider's device-code option for a headless VPS; it does not duplicate token exchange
or refresh logic. Pi persists and refreshes the credentials. Relevant primary source:

- [OpenAI Codex OAuth implementation](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/oauth/openai-codex.ts)
- [Pi OAuth callback and credential contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md#oauth-support)

Pi `0.80.10` replaces the prior `AuthStorage`/`ModelRegistry` SDK wiring with the async
`ModelRuntime` API. Exy was migrated to that API for provider-scoped login, credential
refresh, model availability, and child sessions. The upgrade was required because
`0.80.6` did not contain the native OpenCode Go Kimi K3 catalog entry.

Codex model choices come from Pi's authenticated native catalog. OpenCode Go publishes a
current public model endpoint at `https://opencode.ai/zen/go/v1/models`; Exy retrieves it
during login, intersects the result with Pi's pinned native `opencode-go` catalog, then
validates the submitted key with a minimal request through one model in that intersection. This avoids hard-coded selectors while
ensuring every selected model has Pi's required protocol and reasoning metadata. The
[OpenCode Go documentation](https://opencode.ai/docs/go/) identifies Kimi K3 as
`opencode-go/kimi-k3` and documents the model endpoint.

Exy's specialized child sessions use Pi's in-process `createAgentSession()` and
`SessionManager.inMemory()` primitives. Research children receive the current main model
and reasoning; writing children receive the persisted OpenCode Go preference. No token,
iteration, runtime, or tool-call cap is added around those sessions.

## Provider APIs and package names

Exy uses small typed REST adapters because only a narrow portion of each service is
needed. This keeps search, fetch, memory, publish, and analytics operations behind focused
tools. For completeness, the official JavaScript SDK package names confirmed during
research were:

| Provider | Official package | Exy transport | Primary documentation |
| --- | --- | --- | --- |
| Supermemory | `supermemory` | Bearer-authenticated REST | [SDK](https://supermemory.ai/docs/integrations/supermemory-sdk), [search API](https://supermemory.ai/docs/api-reference/recall-search/search-memory-entries) |
| Xquik | `x-twitter-scraper` | `x-api-key` REST | [TypeScript SDK](https://docs.xquik.com/sdks/typescript), [API overview](https://docs.xquik.com/api-reference/overview) |
| Zernio | `@zernio/node` | Bearer-authenticated REST | [quickstart](https://docs.zernio.com/), [create post](https://docs.zernio.com/posts/create-post) |
| Exa | `exa-js` | `x-api-key` REST | [JavaScript SDK](https://exa.ai/docs/sdks/javascript-sdk), [search API](https://exa.ai/docs/reference/search) |

The implemented base URLs are exactly those published by the providers:
`https://api.supermemory.ai`, `https://xquik.com/api/v1`,
`https://zernio.com/api/v1`, and `https://api.exa.ai`.

Implemented operations are:

- Supermemory v3 document ingestion plus v4 direct memories, profile, and search;
- Xquik account check and X tweet search;
- Zernio account list/health, post validation/create/status, post analytics, and follower
  statistics;
- Exa search and contents retrieval.

The provider adapters accept dependency-injected `fetch`, which is how tests exercise
request and response contracts without network calls or real publication.

## Rate limits

Limits below are the official values observed during research, not constants embedded in
Exy:

- Xquik documents 60 GET/HEAD/OPTIONS requests per 1 second, 30 write requests per 60
  seconds, and 15 delete requests per 60 seconds. Exy uses only GET search/account
  operations. See
  [Xquik rate limits](https://docs.xquik.com/guides/rate-limits).
- Zernio documents account-count request tiers of 60 requests/minute for 0-2 connected
  accounts, 600 for 3-2,000, and 1,200 above 2,000. Analytics also has a per-second
  ceiling derived from the minute tier. Publishing velocity has separate platform rules,
  so Exy does not copy those into code. See
  [Zernio rate limits](https://docs.zernio.com/guides/rate-limits) and its
  [changelog](https://docs.zernio.com/changelog).
- Exa documents 10 search requests/second and 100 contents requests/second. See
  [Exa rate limits](https://exa.ai/docs/reference/rate-limits).
- Supermemory's current Memory API pages did not publish one universal request-rate table.
  Its ingestion guide advises paced bulk ingestion and handling `429`; Exy preserves
  `Retry-After` when present. See [adding memories](https://supermemory.ai/docs/add-memories).
- Discord applies route/bucket rate limits dynamically. Exy uses `discord.js` and its REST
  manager instead of embedding copied Discord limits.

Provider `429` responses are not retried blindly. Exy returns a sanitized error and any
safe retry delay so the agent/user can choose when to try again.

## Discord

The design follows Discord's primary documentation for:

- [gateway intents](https://docs.discord.com/developers/events/gateway#gateway-intents)
  and Message Content access;
- [threads](https://docs.discord.com/developers/topics/threads) and
  [starting a thread from a message](https://docs.discord.com/developers/resources/channel#start-thread-from-message);
- [application commands](https://docs.discord.com/developers/interactions/application-commands)
  and [interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding).

The gateway requests Guilds, Guild Messages, and Message Content intents, creates public
message threads, stores their identity before accepting conversation traffic, and
registers only the four required guild commands.

## Agent Skills and skills.sh

The loader implements the open
[Agent Skills specification](https://agentskills.io/specification) directly and follows
its [progressive-disclosure guidance](https://agentskills.io/client-implementation/adding-skills-support).
The required format is not extended or replaced.

The [skills.sh CLI](https://www.skills.sh/docs/cli) and its
[source](https://github.com/vercel-labs/skills) support a universal agent target and copy
mode that writes `.agents/skills`. That is simpler than maintaining an Exy-specific
GitHub installer, so the documented workflow uses:

```text
npx skills add owner/repository --agent universal --copy
```

No GitHub token is required for public repositories. Private access remains an
operator-managed Git/SSH/GitHub CLI concern.

## HEARTBEAT.md and scheduled work

Research found no open, cross-agent `HEARTBEAT.md` specification comparable to Agent
Skills. OpenClaw has the authoritative documented convention that motivated the request:

- [heartbeat operation](https://docs.openclaw.ai/gateway/heartbeat)
- [HEARTBEAT.md template](https://docs.openclaw.ai/reference/templates/HEARTBEAT)
- [cron jobs](https://docs.openclaw.ai/automation/cron-jobs)

Exy clearly labels its behavior as inspired by that convention. It implements only the
needed semantics with its own SQLite scheduler: off by default, reread on every tick,
exact `HEARTBEAT_OK` suppression, persistent leases/history, one-time/interval/five-field
cron schedules, no shell execution, and no publication bypass.
