# Hermes Mobile — installable APK

The build lives in the GitHub release, not in the repo (a debug APK is 12 MB of
rebuildable binary and would sit in git history forever).

**Download:** https://github.com/joaoalbuq/Hermes-Androidapp/releases/download/v1.4.2/hermes-mobile-1.4.2-debug.apk

- applicationId `com.hermesmobile.viewer`, versionCode 7, versionName 1.4.2
- minSdk 26 (Android 8+), targetSdk 36
- 12,397,059 bytes
- sha256 `5f7b390082e2dbcda95110f35eb415d776b91550e3cb58ca7c6c01c554a34782`
- Debug-signed with this machine's Android debug key (same cert as 1.0–1.2, so it
  installs in place), personal use, not for distribution.

## 1.4.2 — the pick now belongs to the chat, on the phone

1.4.1 stopped picks from being aimed at the wrong chat, but the chat still never owned the choice:
everything the app displayed came from whatever the gateway last said, and it says a lot.

- **A drawer refresh reset the model.** `session.active_list` rows carry a model, and the discovery
  merge took it every time — so the pill quietly went back to the bot's default (or blank) seconds
  after a pick. A refresh is no longer treated as a model change.
- **`session.info` reset it too.** That event also fires for resumes, turn starts and other clients,
  and reports the session's stored default each time. A chat with a pick now ignores the model and
  reasoning in it.
- **The pick is stored on the phone and re-applied.** It is saved per chat, survives relaunch, and
  when a reopened chat is running something else the app puts the choice back on the live session by
  itself (verified against a gateway that reports the default after every restart).
- **The provider stuck to the old one.** Picking a model from another provider left the sheet headed
  with the old provider and marked no row as current, which read as "nothing happened". The provider
  is now part of the pick, and ids match with or without a provider prefix.

Also: the drawer's Refresh button passed its own click event as the profile and failed with
"Could not list sessions" — it refreshes properly now.

## 1.4.1 — the picker stays on the chat you opened it from

Four separate leaks made a model or reasoning pick land somewhere else, and all of them are fixed:

- **The inventory was read once and reused.** `model.options` is per session and per bot, so the
  rows (and the "current" one) could belong to a previous chat. It is now re-read for the chat the
  sheet was opened for, tagged with that chat, and a slower answer for an older chat is dropped.
- **The sheet is bound to one chat.** Picks target the chat it was opened for even if the active id
  moves, and switching chats closes the sheet instead of leaving it over another conversation.
- **The scope reset.** After saving a bot default once, the scope stayed on "Bot" for the next
  opening, so later taps wrote the profile while the open chat kept its model. It now opens on
  "This chat" every time.
- **A failed command fell through to `config.set`.** Any RPC error (unknown model, busy session)
  became a config write, which resolved the target differently and could change the bot's default
  while the chat stayed put. Only a gateway *without* `command.dispatch` falls back now, and that
  fallback addresses the session by its durable id rather than the runtime handle.

Also: a stray `session.info` addressed to a chat this client never attached (another client changing
something) no longer rewrites the open chat's model and reasoning, a reply that reports its own
failure as text is surfaced instead of shown as success, an un-attached chat refuses a pick with a
clear message instead of addressing the durable id, and two quick chat switches can no longer settle
out of order.

## 1.4 — model & reasoning, and notifications in the background

**Model & reasoning.** A pill above the composer shows the chat's live model and reasoning level and
opens a sheet built from the gateway's own `model.options` inventory (providers, per-model reasoning
capability, unavailable rows). Picking a model runs `/model` on the open chat through
`command.dispatch` — the documented mid-session switch, since the wire has no `session.set_model`.
Reasoning offers the full ladder (`none … ultra`) through `/reasoning`; the gateway clamps to what
the route accepts and the app labels the clamped wire level. Both can instead be saved on the bot
with `config.set` scoped to its profile, so the next chat starts there. An expensive model comes
back as `confirm_required` and the sheet asks before writing it.

**Notifications.** When the app is not on screen, a finished turn or an open question (approval,
clarify, sudo…) posts a notification — its own high-importance channel, separate from the ongoing
connection notice, with the chat title and the reply's prose. Android 13+ asks for the permission on
connect, and the Computer tab shows the state. Background turns are badged unread in the drawer.

## 1.3 — stays connected, one chat per bot, the computer in the sidebar

**Background connection.** Android freezes a backgrounded app: timers stop, the
WebSocket dies, and the page never finds out — which is why a locked phone came
back to a chat that had stopped updating. A foreground service with a partial
wake lock and a high-performance Wi-Fi lock now holds the process open, so the
heartbeat keeps running and a turn that finishes behind the lock screen lands in
the transcript (and badges as unread). The ongoing notification says the link is
up and can disconnect it. The Computer tab offers *Allow background* for the
battery-optimisation exemption that long locks otherwise need.

**Reconnects instead of pretending.** Every resume, focus, `online` event, missed
heartbeat (two in a row) or *Wake & re-sync* re-dials rather than trusting a
socket that still reports `OPEN` and answers nothing, then re-attaches the open
chat and reloads its transcript. A host that is merely unreachable is now treated
as transient (`reconnecting`, retried with backoff) instead of `auth_failed`,
which used to park the app until Settings was opened by hand after a lock.

**One chat per bot.** The drawer shows the chat you are in, each bot's synced
chat, and anything live; older chats collapse behind one tap. Sessions from
another bot, and ghost rows left behind by runtime handles that died with an old
socket, are pruned on every discovery pass. Switching bots re-reads the roster
first, so resuming uses that bot's current `last_session` rather than a stale copy.

**Computer tab.** A third drawer tab shows the machine running the gateway from
its own `/api/status`: reachability, version, uptime, bots running, loaded chats,
current bot, transport, and the background-connection state. *Wake & re-sync*
redials and re-reads the host.

## 1.2 — files in both directions

**Sending.** A 📎 button sits in the composer. Picked files are staged on the
gateway (`image.attach_bytes` for images, `file.attach` for everything else) and
ride along with the next message; `prompt.submit` has no attachments field, so
the staged `@file:` reference is what the agent actually sees. Chips above the
composer show what is queued, and each can be removed before sending.

**Receiving.** When the agent delivers a file — `MEDIA:/path/to/file` in its
message — the tag becomes a ⬇ chip. Tapping it fetches the bytes from the gateway
with the signed-in session cookie and writes them into the phone's **Downloads**
folder (MediaStore on Android 10+, the legacy public folder on 8–9, which is the
only version that asks for storage permission). The filename comes from the
gateway's `Content-Disposition`, so it arrives as the agent named it.

## Install

Open that link on the phone, allow "install unknown apps" for the browser or
Files app you downloaded it with, then open the file. It upgrades in place and
keeps your connection and sign-in.

Rebuild from source with `bash scripts/build-apk.sh` (see the repo README).
