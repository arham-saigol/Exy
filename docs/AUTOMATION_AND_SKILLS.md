# Heartbeat, schedules, and Agent Skills

Procedural automation instructions live in the bundled `exy-automation` skill, not in
Exy's main system prompt. This keeps normal X-growth turns focused and loads the detailed
procedure only when automation is relevant.

## HEARTBEAT.md

Exy's workspace contains `/var/lib/exy/workspace/HEARTBEAT.md`. The convention is
inspired by OpenClaw's documented
[heartbeat behavior](https://docs.openclaw.ai/gateway/heartbeat) and
[HEARTBEAT.md template](https://docs.openclaw.ai/reference/templates/HEARTBEAT), but it is
an Exy feature: it is not part of Pi or the Agent Skills specification and Exy does not
claim full OpenClaw compatibility.

Heartbeat is off by default. Its initial file contains comments only, which is also
treated as no work. Ask Exy in an active thread to inspect or configure its heartbeat.
The automation skill directs it to use focused tools that can:

- read the current document and persisted settings;
- replace the document;
- enable or disable checks;
- change the whole-minute interval;
- select the current Exy thread as the alert destination.

The scheduler rereads `HEARTBEAT.md` on every tick. Missing content, whitespace,
comments, and Markdown headings alone cause the tick to skip without a model call. For a
real checklist, keep items concise, stable, safe, and free of credentials. If a heartbeat
run returns exactly `HEARTBEAT_OK`, no Discord message is sent; any other response is
delivered to the configured thread.

Heartbeat instructions never authorize publication. A check can research, inspect
analytics, or prepare a draft, but only a later explicit instruction from the authorized
user can publish that exact draft.

## Scheduled jobs

Exy's own SQLite scheduler supports:

- one-time ISO 8601 timestamps;
- fixed whole-minute intervals;
- standard five-field cron expressions with an explicit IANA timezone.

Ask Exy to create, list, update, remove, or inspect the history of scheduled work. These
operations create registered in-process agent-prompt jobs, not shell commands, crontab
entries, or systemd timers. Jobs are scoped to the configured Discord user and connected
X account and normally deliver their result to the thread where they were created.

Before execution, the gateway atomically claims a persistent lease. It renews the lease
while work runs, prevents another runner from concurrently executing that same job, and
records `running`, `succeeded`, `failed`, or `abandoned` history with timing and a concise
sanitized result. Expired work is recovered diagnostically after a crash. Recurring jobs
advance to their next future occurrence rather than replaying an entire missed backlog.

Cron timing is evaluated using the stored IANA timezone. Daylight-saving transitions
therefore follow that timezone's rules. Prefer `UTC` when wall-clock local time is not a
requirement.

## Open Agent Skills discovery

Exy discovers the open Agent Skills format from:

```text
/var/lib/exy/workspace/.agents/skills/<skill-name>/SKILL.md
```

It follows the current [Agent Skills specification](https://agentskills.io/specification):
an exact-case `SKILL.md`, YAML frontmatter, a lower-case hyphenated name matching its
directory, and a non-empty description. Exy initially exposes skill metadata, then loads
the complete instructions only when the agent activates that skill. Contained text
resources can be read afterward. This is the recommended
[progressive-disclosure integration](https://agentskills.io/client-implementation/adding-skills-support).

The loader validates each skill dynamically, caps file sizes, confines resources to the
skill directory, and rejects symlinked skill roots, directories, and `SKILL.md` files. A
new valid skill becomes available without rebuilding or changing Exy source.

## Install a public skill with skills.sh

The official skills.sh CLI can install to the universal `.agents/skills` directory, so
Exy does not add a competing installation command or format. Run it as the service user
from the workspace:

```bash
sudo -u exy env HOME=/var/lib/exy DISABLE_TELEMETRY=1 \
  bash -lc 'cd /var/lib/exy/workspace && npx skills add owner/repository --agent universal --copy'
```

Review a third-party skill before activating or installing it. A skill supplies agent
instructions; it does not receive an automatic permission grant. Exy's focused tools,
scope checks, verifier, and explicit-user publishing rule remain enforced.

For a private repository, authenticate Git or GitHub CLI outside Exy and use the access
method supported by that repository. Setup deliberately does not request a GitHub token
for the public skills.sh workflow. See the current [skills.sh CLI reference](https://www.skills.sh/docs/cli)
and [source repository](https://github.com/vercel-labs/skills) for flags and repository
forms.

To diagnose a skill, check its directory ownership and `SKILL.md`, then ask Exy to list
installed skills. Invalid skills are excluded rather than partially loaded. Gateway logs
contain validation diagnostics without dumping the skill body.
