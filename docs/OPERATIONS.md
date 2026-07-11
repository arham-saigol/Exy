# Operating Exy

The `exy` command hides systemd and journald for normal operation. Run lifecycle commands
with `sudo` on the supported Ubuntu installation.

## Lifecycle and logs

```bash
sudo exy start
sudo exy stop
sudo exy restart
sudo exy status
sudo exy logs
sudo exy logs -f
```

The service starts after `network-online.target`, runs as the unprivileged `exy` user,
and restarts after failures. `/restart` causes a deliberate gateway exit that systemd
also restarts. A normal `exy stop` does not restart it.

Logs are structured JSON from the gateway plus startup errors. Provider failures are
sanitized before logging. Do not enable `EXY_DEBUG=1` routinely; although provider
transport errors remain sanitized, debug stacks can reveal local filesystem details.

## Routine health check

Run this after setup, credential rotation, an update, or an unexplained failure:

```bash
sudo exy doctor
```

Doctor checks Node and host commands, configuration, restrictive secret permissions,
writable data paths, refreshable Pi authentication, the persisted model/reasoning pair,
provider and Discord connectivity, and systemd state. An intentionally stopped gateway
is a warning; missing configuration, invalid credentials, or an inaccessible path is a
failure and produces a nonzero status.

## Publishing dry run

For a safe end-to-end approval exercise, add a systemd override:

```bash
sudo systemctl edit exy.service
```

Enter:

```ini
[Service]
Environment=EXY_DRY_RUN=1
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo exy restart
```

In dry-run mode Exy still validates the post, creates an exact approval, requires the
later approval message, and consumes that approval once. It does not call Zernio's
publish endpoint and explicitly reports that publication was not confirmed.

Remove the override before real operation:

```bash
sudo systemctl revert exy.service
sudo systemctl daemon-reload
sudo exy restart
```

## Back up and restore

The durable local state is `/etc/exy` plus `/var/lib/exy`. Supermemory content is remote,
but its namespace depends on the configured Discord user and X account IDs, so include
configuration in the backup. Stop Exy to obtain a simple consistent SQLite/WAL snapshot:

```bash
sudo exy stop
sudo tar --numeric-owner -C / -czf /root/exy-backup.tgz etc/exy var/lib/exy
sudo exy start
```

The archive contains provider and OAuth credentials. Protect it like a password vault,
encrypt it off-host, and do not commit it.

To restore on a replacement host, install the same or a newer compatible Exy release,
stop the service, extract the archive at `/`, restore ownership and modes, diagnose, and
start:

```bash
sudo exy stop
sudo tar --numeric-owner -C / -xzf /root/exy-backup.tgz
sudo chown -R exy:exy /etc/exy /var/lib/exy
sudo chmod 0700 /etc/exy /var/lib/exy
sudo chmod 0600 /etc/exy/config.json /etc/exy/secrets.json
sudo exy doctor
sudo exy start
```

## Update Exy

Update atomically enough that the running service never observes a half-built source
tree. In a normal checkout:

```bash
cd /opt/exy
sudo git pull --ff-only
sudo npm ci
sudo npm run check
sudo npm run build
sudo npm install --global . --prefix /usr/local
sudo exy setup
sudo exy doctor
sudo exy restart
```

Rerunning setup refreshes the systemd `ExecStart` path and copies bundled workspace files
only when they are absent. It does not overwrite the live `HEARTBEAT.md`, installed
skills, model choice, or existing secrets left blank at prompts.

Pi's model catalog is release-bundled, so upgrading the pinned Pi packages and rebuilding
Exy is how newly supported model metadata becomes available. Always run `/model` and
`/reasoning` after such an update before assuming a prior selection is still valid.

## Data retention

SQLite retains Discord thread registrations, reply recommendations, prepared approvals,
approval-bound provider publication attempts, model preferences, scheduled jobs, and
execution history. Publication approvals expire and are one-time, but their audit rows
remain. Removed jobs are soft-deleted. There is no
automatic destructive retention job in this release; size and backup retention remain an
operator decision.

Pi thread sessions are append-oriented JSONL files below `/var/lib/exy/sessions`. Remove
them only when you deliberately want to discard that thread's conversational state.
Supermemory remains separate and survives local session deletion.
