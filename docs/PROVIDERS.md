# Provider setup

Exy talks to each provider through a small REST adapter. Provider keys are written to
`/etc/exy/secrets.json` with mode `0600`; they are never copied into the repository or
included in normal logs. Run `sudo exy setup` to add or replace them, then
`sudo exy doctor` to perform safe connectivity checks.

## Supermemory

1. Create a Supermemory account and API key using the
   [official quickstart](https://supermemory.ai/docs/quickstart).
2. Enter that key when setup asks for `Supermemory API key`.

Exy uses the v4 profile, search, and memory endpoints and the v3 document endpoint for
conversation ingestion. Every request uses a deterministic `containerTag` derived from
the configured Discord user ID and a SHA-256 hash of the selected Zernio X account ID.
Changing either identity creates a different memory namespace. Exy recalls profile and
semantic context before a turn and submits the completed exchange afterward. The agent
also has a focused tool for storing durable voice, preference, and strategy facts.

The provider processes document ingestion asynchronously. Do not expect a fact written
at the end of one message to be searchable instantly. Supermemory recommends spacing
large ingestion workloads and honoring HTTP `429` responses; Exy's provider errors retain
a safe `Retry-After` value when one is supplied. See the official
[search](https://supermemory.ai/docs/search),
[user profile](https://supermemory.ai/docs/user-profiles), and
[adding memories](https://supermemory.ai/docs/add-memories) documentation.

## Xquik

1. Create an API key in Xquik by following the
   [official API overview](https://docs.xquik.com/api-reference/overview).
2. Enter it during setup.

Exy uses `GET /api/v1/x/tweets/search` with the `x-api-key` header. Raw results expose
only process-local opaque candidate references to the agent. A post ID becomes durable
only when the agent calls the recommendation boundary, where the reply verifier
canonicalizes and records it. Restarting the gateway intentionally discards unresolved
raw candidates.

The documented Xquik limit for GET/HEAD/OPTIONS requests was 60 requests per second when
this release was researched. Treat the provider's current response headers and
[rate-limit documentation](https://docs.xquik.com/guides/rate-limits) as authoritative.

## Zernio

Zernio is Exy's only X publishing and analytics integration.

1. Create a Zernio API key.
2. Connect the intended X/Twitter account in Zernio first.
3. Run `sudo exy setup`. The wizard retrieves connected `twitter` accounts and asks you
   to select one. It stores the account ID, not a bearer token, in non-secret config.
4. Choose whether to enable X analytics. Zernio documents that background X analytics may
   incur pass-through X API charges, so background analytics sync remains disabled unless
   explicitly accepted. This preference does not gate Exy's read-only account, analytics,
   or post-history tools. Every setup rerun reconciles the selected account to that choice,
   and switching accounts disables analytics on the old account.
   Enabling it also requires the account to report Zernio analytics add-on access; setup
   refuses an unsupported selection and doctor checks `canFetchAnalytics`.

The integration follows Zernio's official account, post, validation, and analytics APIs:

- [list connected accounts](https://docs.zernio.com/accounts/list-accounts)
- [list posts](https://docs.zernio.com/posts/list-posts)
- [create a post](https://docs.zernio.com/posts/create-post)
- [retrieve post analytics](https://docs.zernio.com/analytics/get-analytics)
- [retrieve follower statistics](https://docs.zernio.com/accounts/get-follower-stats)

A reply is a normal publish request whose X platform target includes
`platformSpecificData.replyToTweetId`. After the user explicitly tells Exy to publish
the current conversation draft, Exy calls Zernio's content validation endpoint,
atomically consumes the exact stored draft, sends an internal idempotency request ID, and
accepts publication as confirmed only when the response contains the configured X target
with `status: "published"`. An accepted, queued, pending, partially failed, or malformed
response is not reported as success. When Zernio returns a nonterminal record ID, Exy
binds it to the consumed draft. Its focused no-ID status tool polls the latest bound
provider record in that Discord conversation without creating a second publication.

Zernio's request limits depend on connected-account count and its platform publishing
limits can change. Exy surfaces sanitized `429` errors and retry delays; consult the
current [rate limits](https://docs.zernio.com/guides/rate-limits) and
[error handling](https://docs.zernio.com/guides/error-handling) pages rather than relying
on a copied limit.

## Exa

1. Create an Exa API key using the [official Exa documentation](https://exa.ai/docs).
2. Enter it during setup.

Exy uses `POST /search` for web discovery and `POST /contents` for page retrieval. The
agent receives focused `search_web` and `fetch_web_pages` tools instead of unrestricted
network access. `exy doctor` performs a one-result search because Exa does not document a
separate no-usage credential introspection endpoint.

At the time of research Exa documented 10 search requests per second and 100 contents
requests per second. Use Exa's current
[rate-limit page](https://exa.ai/docs/reference/rate-limits) as the source of truth.

## Credential rotation

Rerun setup and enter the replacement key at its prompt. A blank answer retains an
existing valid secret. Then restart and diagnose the gateway:

```bash
sudo exy restart
sudo exy doctor
```

Provider errors include only an allow-listed provider name, HTTP status, short code,
sanitized message, and optional retry delay. Request headers and raw response bodies are
not attached to thrown errors.
