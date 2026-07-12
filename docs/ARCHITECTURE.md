# Architecture and safety boundaries

Exy is one Node.js gateway process managed by systemd. It composes Pi, Discord, provider
adapters, SQLite state, skill discovery, and a scheduler. The application does not expose
an HTTP administration server.

## Runtime flow

1. Discord accepts a starter only from the configured user in a server text channel, or
   a continuation in a durably registered Exy thread, then resolves or creates the thread.
2. The gateway serializes turns within that thread and loads its own Pi JSONL session.
3. Exy recalls the matching Supermemory profile and semantic memories.
4. Pi runs with the persisted model/reasoning preference and a lean X-growth system
   prompt. Only focused Exy and automation tools are exposed; Pi's built-in shell and
   file tools are disabled.
5. Sanitized tool-start statuses flow through an ordered Discord progress stream while a
   typing keepalive remains active. Model-authored text stays private until the completed
   response passes the verifier and publication guards.
6. The guarded final response is returned to the thread exactly once, then the completed
   exchange is submitted to the same Supermemory namespace only after final delivery
   succeeds.

Separate Discord threads have separate Pi sessions and queues. Long-term memory is
isolated by both authorized Discord user and connected Zernio X account. Scheduled-job
payloads and publication approvals carry the same scope.

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
always pass through their separate structured renderer.

Pi can inspect raw candidate text so it can decide what is relevant. If a turn searches
X but stages no verifier-approved recommendation, the gateway replaces free model prose
with a generic no-new-opportunity result. Candidate text and author descriptions therefore
cannot become a URL-free verifier bypass. Preparing a reply also stages its displayed
target through the same boundary automatically.

The final-output guard also removes X status URLs that did not originate from a
recommendation staged for this delivery, a confirmed publish result, a prepared reply
target, or the explicit original-draft renderer. Analytics and web-search URLs receive
no blanket exemption: presenting one as an opportunity requires the recommendation
tool. The original-draft path is a narrow exemption and never authorizes publication.
This is defense in depth around the tool boundary, not a substitute for it.

Success-claim filtering scans all free model prose, including Markdown fences. Only
gateway-owned fenced payloads such as exact prepared content and explicitly rendered
draft/recommendation quotes opt into byte-preserving fence treatment.

## Publication transaction

Publishing is an exact two-message transaction:

1. Pi calls `prepare_x_publication`. Exy validates the content with Zernio, canonicalizes
   a reply target supplied either by the current Xquik search or as a direct post ID/URL,
   and stores an immutable scoped payload plus a short-lived one-time approval secret.
2. Exy shows the exact text, target, expiry, and approval code. Preparation never calls
   the publish endpoint.
3. The authorized user later sends exactly `approve EXY_APPROVAL:<id>:<token>` as a
   standalone message in the matching scope. Negated, quoted, or embedded command text
   is not approval. The gateway verifies the token, expiry, scope, and payload integrity.
4. Only the now-approved immutable record can be consumed by `publish_approved_x`.
   Consumption is atomic and one-time, and Zernio receives an idempotency request ID.
5. The gateway replaces model-authored publication prose with a deterministic result. It
   says publication succeeded only if Zernio's response identifies the configured X
   target with `status: published`. A pending response exposes its provider record so a
   focused status tool can reconcile it later.

Editing content, changing target, using another user/account scope, reusing a
token, waiting past expiry, or approving an unrelated draft fails closed. Schedules and
heartbeat prompts are not approval channels. `EXY_DRY_RUN=1` exercises this transaction
without sending the final provider request.

Approval scope is the configured Discord user plus connected X account. The same
authorized user may deliberately paste the exact standalone approval command in another
active Exy thread for that account; the immutable payload is unchanged. Conversation
history and live agent sessions remain isolated per thread.

## Local persistence

SQLite runs in WAL mode and owns:

- thread registrations and their X-account binding;
- per-thread model preferences;
- canonical reply recommendations;
- prepared and consumed publication approvals;
- provider publication attempts bound to their exact consumed approvals;
- scheduled jobs, leases, and run history.

Configuration and provider secrets are atomic JSON files with mode `0600`. Pi owns a
separate `auth.json` with its OAuth refresh credential. Thread session JSONL and the live
workspace are private to the system user. See [operations](OPERATIONS.md) for backup
instructions.

## Provider boundaries

- Xquik searches X but cannot publish.
- Zernio validates, publishes, lists the selected account, and retrieves analytics.
- Exa searches the web and retrieves page contents.
- Supermemory stores and recalls long-term context.
- Pi performs model inference and OAuth credential management.

The common provider transport never attaches headers or raw bodies to public errors. It
retains only status, an allow-listed short code/message, and an optional retry delay,
while redacting configured secrets and common token patterns.
