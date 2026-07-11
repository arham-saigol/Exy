---
name: exy-automation
description: Safely operate Exy's HEARTBEAT.md convention and persisted scheduled jobs. Use when the user asks about recurring checks, heartbeat work, one-time reminders, cron schedules, job changes, or automation failure history.
license: MIT
compatibility: Exy on Node.js 22.19+ with its SQLite scheduler and focused automation tools.
metadata:
  author: exy
  version: "1.0.0"
---

# Exy automation

Use Exy's focused tools only. Never create host crontab entries, systemd timers, shell commands, or executable heartbeat content.

## Heartbeat execution

`HEARTBEAT.md` is a small workspace checklist inspired by OpenClaw's heartbeat convention. It is not part of Pi or the Agent Skills specification, and Exy does not claim full OpenClaw compatibility.

- Heartbeat is controlled by persisted configuration and is off by default.
- Use `inspect_heartbeat` before changing it.
- Use `update_heartbeat` to replace the checklist, change its interval, enable or disable it, and select the current Exy thread for alerts.
- Exy re-reads the file for every tick. A missing task body, whitespace, comments, or headings alone causes no model work for that tick.
- Keep the checklist short, stable, and free of credentials, tokens, private keys, and provider payloads.
- During a heartbeat turn, complete only safe work authorized by the checklist and the user's standing instructions.
- If nothing requires the user's attention, return exactly `HEARTBEAT_OK` with no additional text. Exy suppresses only that exact trimmed response. Any other response is treated as an alert and delivered to the configured thread.
- Publication approval rules still apply. A heartbeat may research, analyze, or prepare a draft, but it cannot approve or publish content on the user's behalf.

Disable heartbeat when the recurring checklist is no longer useful. Prefer a scheduled job when work needs a distinct cadence, an exact time, or a one-time execution.

## Persisted scheduled jobs

Exy's scheduler supports:

- one-time work at an ISO 8601 date/time;
- fixed intervals expressed in whole minutes;
- standard five-field cron expressions: minute, hour, day-of-month, month, weekday.

For cron work, always use an explicit IANA timezone such as `Asia/Karachi` or `UTC`. Explain daylight-saving effects when the selected timezone observes them. Do not translate a user's local time into server-local time silently.

Use the focused tools in this lifecycle:

1. `list_scheduled_jobs` before creating a similar recurring job, to avoid accidental duplicates.
2. `create_scheduled_job` with a precise name, self-contained prompt, delivery thread, and the simplest suitable schedule.
3. `update_scheduled_job` for changes; do not create a replacement unless the user requests a separate job.
4. `inspect_scheduled_job_history` after failures or when verifying operation. Report the recorded status and sanitized error; do not claim a run succeeded based only on it starting.
5. `remove_scheduled_job` when the work is no longer wanted.

The gateway takes a persistent lease before each run, prevents overlapping executions of the same job, and records timing, outcome, concise output, and sanitized failures. It skips missed backlog on restart rather than replaying every missed occurrence. Treat provider-side success separately: scheduled execution success never proves that an X publication succeeded; only Zernio's confirmed target status does.

Scheduled prompts are not an authorization channel. They cannot broaden access, approve prepared publications, install skills, change secrets, or act outside the configured Discord user and connected X-account scope.
