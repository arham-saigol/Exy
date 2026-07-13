# Troubleshooting

Start with:

```bash
sudo exy doctor
sudo exy status
sudo exy logs
```

Doctor returns a nonzero exit code for blocking problems and never prints secret values.

## `exy` is not found

Build and reinstall the global package, then confirm npm's global binary directory is on
root's `PATH`:

```bash
cd /opt/exy
sudo npm run build
sudo npm install --global . --prefix /usr/local
command -v exy
exy help
```

## Node is too old

Exy and its pinned Pi SDK require Node 22.19 or newer. Rerun the verified bootstrap:

```bash
cd /opt/exy
sudo bash scripts/bootstrap-ubuntu.sh
node --version
```

The bootstrap supports only Ubuntu `amd64` and `arm64`. It exits instead of installing an
unverified archive if the official checksum does not match.

## Pi login or refresh fails

Run login interactively while the gateway is stopped so only one process touches Pi's
credential file:

```bash
sudo exy stop
sudo exy login
sudo exy start
```

Complete the displayed device-code flow before it expires. If Pi reports a credential
lock failure after a crash, inspect `/var/lib/exy/pi-agent/auth.json.lock` while the
service is stopped. A normal Pi lock is temporary; do not delete an active lock. If the
path is a stale malformed regular file rather than Pi's lock directory, move that single
path aside and rerun login. Never print or hand-edit `auth.json`.

## A model appears but OpenAI rejects it

Exy lists the authenticated `openai-codex` models exposed by the installed Pi registry.
Pi does not currently provide a remote account-entitlement listing operation, so a model
can be present in Pi's catalog but unavailable to a particular subscription. Use
`/model` to choose another listed model, or upgrade Exy's pinned Pi release if its catalog
is stale. Exy intentionally does not probe every model because that would consume usage.

If a reasoning value becomes invalid after changing models, `/model` selects a valid
default reported by Pi. `/reasoning` shows only the selected model's supported levels.

## No Discord response

Check all of the following:

- the message author exactly matches the configured authorized user;
- the starter message is in a server text channel, or the message is in an active
  Exy-created thread;
- the starter message mentions the bot;
- Message Content Intent is enabled in the Developer Portal;
- the bot can view history, send messages, create public threads, and send in threads;
- the application and authorized-user snowflake IDs are correct.

Exy deliberately ignores unauthorized and unregistered contexts without explaining its
internal routing state. Rerun setup to correct IDs. Because no channel is configured in
advance, `exy doctor` cannot preflight per-channel permission overrides; inspect the
channel permissions if thread creation fails.

## A thread exists but Exy does not adopt it

Only threads durably claimed and created from an authorized starter are
valid Exy threads. This prevents a mention in an arbitrary sibling thread from bypassing
routing controls. Start a new mention in a server text channel. If Discord created the
thread but the gateway crashed before activating it, restart once; Exy can recover only a
bot-owned thread whose ID matches the claimed starter message.

## Provider check fails

Rotate the affected key with `sudo exy setup`, then rerun doctor. Common safe diagnoses:

- `401` or `403`: wrong, revoked, expired, or insufficiently privileged key;
- `404`: selected Zernio account was removed; rerun setup and select it again;
- `429`: provider limit reached; honor the reported retry delay;
- network error: DNS, firewall, proxy, certificate, or provider availability issue;
- invalid response: upstream returned non-JSON or a schema incompatible with this Exy
  release; retain sanitized logs and compare the provider changelog.

Exa doctor performs a small real search. Zernio background analytics sync remains disabled
unless setup records explicit acceptance of its possible pass-through charge; Exy's
read-only Zernio account, analytics, and post-history tools remain available either way.

## A publish was queued or accepted but not reported as successful

This is expected. Exy requires target-level Zernio confirmation with `status: published`.
A request-level `2xx`, post-level status, pending job, or another platform's success is
not enough. If Zernio returned a nonterminal provider record, ask Exy to recheck the
publication status in the same Discord conversation. The provider record and draft ID
remain internal; the user does not need to supply either one. Otherwise inspect the
returned sanitized provider message.

If `EXY_DRY_RUN=1` is set, no real publish request is made and confirmation is always
false. Check the effective service environment:

```bash
sudo systemctl show exy.service -p Environment
```

## A reply opportunity is reported as already recommended

That is the verifier working. Alternate `x.com`, `twitter.com`, `www`, and mobile status
URLs resolve to the same numeric post ID. Records survive restarts and are isolated by
configured user and X account. Original-post drafts are unaffected. There is no supported
command to clear a verifier record accidentally; preserve this invariant.

## Heartbeat does nothing

Heartbeat is off by default. It also skips a file containing only comments, headings, or
whitespace. In an active Exy thread, ask it to activate the `exy-automation` skill,
inspect the heartbeat, add a checklist, and enable it. That thread becomes the delivery
target. Check scheduled run history and logs if a populated enabled heartbeat still
fails.

## A scheduled job is `abandoned`

The gateway stopped renewing its lease before the handler completed, usually because of
a restart, crash, or forced shutdown. The recorded error and timing are diagnostic. A
later occurrence can run normally; Exy does not replay every missed interval. Inspect
history before deciding whether to run the task manually.

## An installed skill is missing

Verify:

```bash
sudo -u exy find /var/lib/exy/workspace/.agents/skills -maxdepth 2 -name SKILL.md -print
```

The directory name and frontmatter `name` must match, use lower-case letters/numbers and
single hyphens, and stay at 64 characters or fewer. `description` is required. The skills
root, skill directory, and `SKILL.md` cannot be symlinks. Install as the `exy` user so it
can read the files. Valid changes are discovered dynamically; no rebuild is required.

## SQLite or permissions failure

Stop the service before manual recovery. Restore owner and private modes:

```bash
sudo exy stop
sudo chown -R exy:exy /etc/exy /var/lib/exy
sudo chmod 0700 /etc/exy /var/lib/exy /var/lib/exy/workspace
sudo chmod 0600 /etc/exy/config.json /etc/exy/secrets.json
sudo exy doctor
sudo exy start
```

Do not delete `exy.sqlite`, its `-wal`/`-shm` files, or Pi session files as a generic fix.
Restore a consistent backup if the database is actually corrupt.
