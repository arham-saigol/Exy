# Architecture and safety boundaries

Exy is one Node.js gateway process managed by systemd. It composes Pi, Discord, provider
adapters, SQLite state, skill discovery, and a scheduler. The application does not expose
an HTTP administration server.

## Runtime flow

1. Discord accepts a starter only from the configured user in a server text channel, or
   a continuation in a durably registered Exy thread, then resolves or creates the thread.
2. The gateway serializes turns within that thread and loads its own Pi JSONL session.
3. Exy recalls the matching Supermemory profile and semantic memories.
4. Pi runs a lean coordinator with the persisted main model/reasoning preference. It keeps
   focused X/web tools for quick work, but substantial research runs in an ephemeral child
   session with the same model and reasoning. Every reply/original-post draft runs in an
   ephemeral child session using the separately persisted OpenCode Go writing model.
   Child sessions receive only role-specific provider and confined skill tools; Pi's built-in
   shell and file tools remain disabled.
5. The writing tool saves the child's exact output and reply target before returning it to
   the coordinator. The coordinator has no direct content-bearing draft-save tool.
6. Complete intermediate assistant messages and sanitized tool-start statuses flow
   through an ordered Discord stream while a typing keepalive remains active. Token
   deltas, reasoning, and tool internals are never sent; assistant text passes the same
   verifier and publication guards before delivery.
7. The remaining guarded response is returned to the thread exactly once, then the completed
   exchange is submitted to the same Supermemory namespace only after final delivery
   succeeds.

Separate Discord threads have separate Pi sessions and queues. Long-term memory is
isolated by both authorized Discord user and connected Zernio X account. Scheduled-job
payloads and publication drafts carry the same scope.

Thread creation uses a durable `creating` claim before calling Discord. On gateway
restart, Exy resumes those claims by adopting the bot-owned thread or refetching the
original authorized starter message and completing creation. An in-thread message can
also activate an already-created bot thread after the narrow claim/activation crash
window.

Each thread is permanently bound to the X account selected when it was created. If setup
changes the connected account or authorized user, old threads are rejected and their
scheduled jobs are disabled on the next due run; start a new parent-channel thread. This
prevents stale sessions from retaining control of a previously selected account.

## Reply recommendation verifier

Xquik search results are raw candidates, not recommendations. They live only in a bounded
in-memory map and are represented to Pi by opaque references. The only tool that can
present a candidate as a reply opportunity resolves the reference and passes its X post
ID through the persistent verifier.

The verifier accepts numeric post IDs and recognized `x.com`, `twitter.com`, `www`,
`mobile`, and `m` status URL forms. The tool first reserves a canonical numeric ID in
process; it does not write the recommendation yet. The final response must contain the
canonical URL. After Discord accepts each message chunk, the gateway commits any scoped
recommendation whose complete URL has now been delivered. If a later chunk fails, an
already shown opportunity remains recorded while reservations for opportunities that
were not shown are released. Alternate URLs converge on the same unique ID across
restarts. If that record already exists, the tool tells Pi it was already recommended
and does not return it as a new opportunity. A second thread that encounters an
in-flight reservation must defer instead of displaying the target; it can retry once the
owning delivery commits or releases it. Original-post drafts do not use this path and
are saved as exact thread-scoped drafts before presentation.

Pi can inspect raw candidate text so it can decide what is relevant. If a turn searches
X but stages no verifier-approved recommendation, the gateway replaces free model prose
with a generic no-new-opportunity result. Candidate text and author descriptions therefore
cannot become a URL-free verifier bypass. Saving a reply draft also stages its displayed
target through the same boundary automatically.

The final-output guard also removes X status URLs that did not originate from a
recommendation staged for this delivery, a confirmed publish result, or an exact saved
draft. Analytics and web-search URLs receive
no blanket exemption: presenting one as an opportunity requires the recommendation
tool. The original-draft path is a narrow exemption and never authorizes publication.
This is defense in depth around the tool boundary, not a substitute for it.

Success-claim filtering scans all free model prose. Exact saved draft text is protected
byte-for-byte while surrounding conversational framing remains subject to the guards.

## Publication transaction

Publishing consumes an exact conversation draft:

1. The coordinator calls `spawn_writing_subagent` with the full request, research, source
   posts, audience, preferences, and reply target. The OpenCode Go child returns only draft
   text; the outer tool canonicalizes the target and saves those exact bytes before returning.
   This replaces that thread's previous current draft and never calls a publishing endpoint.
2. The authorized user explicitly tells Exy to publish the current draft. If the intent
   or reference is ambiguous, Exy asks a concise clarification question.
3. In that same turn Pi calls `publish_current_x_draft`, which accepts neither content
   nor an ID. Exy validates the stored bytes, atomically consumes them once, and sends
   them to Zernio with an internal idempotency request ID.
4. Exy reports success only if Zernio identifies the configured X target with
   `status: published`. A focused no-ID status tool can reconcile a bound nonterminal
   provider record later.

Changing content or target creates a new current draft. Another thread, user/account
scope, schedules, and heartbeat prompts cannot authorize publication. `EXY_DRY_RUN=1`
exercises validation and one-time consumption without sending the final provider request.

## Local persistence

SQLite runs in WAL mode and owns:

- thread registrations and their X-account binding;
- per-thread model preferences;
- canonical reply recommendations;
- current, superseded, and consumed per-thread publication drafts;
- provider publication attempts bound to their exact consumed drafts;
- scheduled jobs, leases, and run history.

Configuration and provider secrets are atomic JSON files with mode `0600`. Pi owns a
separate `auth.json` containing provider-scoped Codex OAuth and/or OpenCode Go API-key
credentials; adding one does not remove the other. Thread session JSONL and the live
workspace are private to the system user. See [operations](OPERATIONS.md) for backup
instructions.

## Provider boundaries

- Xquik searches X but cannot publish.
- Zernio validates, publishes, lists the selected account, and retrieves analytics.
- Exa searches the web and retrieves page contents.
- Supermemory stores and recalls long-term context.
- Pi performs model inference and native Codex/OpenCode Go credential management.

The common provider transport never attaches headers or raw bodies to public errors. It
retains only status, an allow-listed short code/message, and an optional retry delay,
while redacting configured secrets and common token patterns.
