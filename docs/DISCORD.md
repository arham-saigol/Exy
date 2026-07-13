# Discord configuration

Exy is intentionally a single-operator Discord bot. It accepts control only from one
configured user. That user can start an Exy thread in any server text channel where the
bot is installed and has the required permissions.

## Create the application and bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create
   an application and add a bot.
2. On the Bot page, enable the privileged **Message Content Intent**. Exy needs message
   text both to detect a channel mention and to continue conversation inside a
   thread. The implementation requests only Guilds, Guild Messages, and Message Content
   gateway intents.
3. Copy the application/client ID and bot token. Treat the bot token as a password.
4. Enable Developer Mode in your Discord client, then copy the authorized user ID.

Discord documents gateway intents and the Message Content restriction in its
[Gateway intents reference](https://docs.discord.com/developers/events/gateway#gateway-intents).

## Install the bot

Generate an installation URL for the bot and `applications.commands` scopes. Grant the
bot these permissions in each channel where you intend to start Exy threads:

- View Channel
- Read Message History
- Send Messages
- Create Public Threads
- Send Messages in Threads

Exy starts a public thread from the mention message, as defined by Discord's
[start-thread-from-message endpoint](https://docs.discord.com/developers/resources/channel#start-thread-from-message).
It does not need Manage Threads for its normal flow. Channel overrides can still deny an
otherwise guild-wide permission, so check the parent channel explicitly.

## Configure Exy

Run:

```bash
sudo exy setup
```

Enter the bot token, application ID, and authorized user ID. At startup, the gateway
discovers each server where the bot is installed and registers four guild-scoped slash
commands, so command changes are normally visible immediately:

- `/model [model]` shows Pi-exposed models or changes the persisted default.
- `/reasoning [level]` shows levels supported by the active model or changes the default.
- `/interrupt` aborts the active agent turn in the current Exy thread.
- `/restart` asks the systemd-managed gateway to restart.

Slash-command responses are ephemeral. Commands from another user, a direct message,
an unsupported channel, or an unregistered sibling thread are rejected without exposing
internal routing state. See
Discord's [application commands](https://docs.discord.com/developers/interactions/application-commands)
and [interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
documentation.

## Conversation routing

Mention Exy in a normal message in any server text channel. That channel becomes the
parent for the conversation. Exy atomically claims that starter message, asks Discord
to create a thread, and stores the active thread in
SQLite. Discord makes a thread created from a message use the starter message ID as the
thread ID; Exy checks this identity when restoring state.

Inside an active Exy thread, ordinary messages from the authorized user continue that
thread's persistent Pi session without needing another mention. A message in a separate
Exy thread uses a separate JSONL session and FIFO queue. Turns in different threads may
run independently; turns within one thread are serialized. Exy never adopts an arbitrary
thread merely because somebody mentions the bot there.

Bot messages and all messages from unauthorized users are ignored. Responses suppress
Discord mentions and are split safely below Discord's 2,000-character message limit.
While a turn is active, Exy refreshes Discord's typing indicator and shows short,
allowlisted descriptions of tool activity. After a skill is activated successfully,
Discord also shows its validated skill name. Raw tool arguments, internal names,
credentials, model reasoning, and unguarded model text are never rendered as progress.
The completed response passes Exy's verifier and publication guards before being delivered
exactly once. Progress failures are isolated from that authoritative final delivery.

## First routing test

After `sudo exy start`, send a message such as:

```text
@Exy Help me define three themes for my X account. Do not publish anything.
```

Expected result:

1. one public `Exy - ...` thread is created from that message;
2. the response appears inside the thread;
3. a second message in the thread continues the same conversation;
4. repeating the starter event does not create a second thread;
5. the same action from a different Discord user gets no agent response.

If this fails, run `sudo exy doctor` and `sudo exy logs -f`. The most common causes are a
missing Message Content Intent, a channel permission override, or an incorrect snowflake
ID.
