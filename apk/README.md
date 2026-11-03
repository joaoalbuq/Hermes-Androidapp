# Hermes Mobile — installable APK

The build lives in the GitHub release, not in the repo (a debug APK is 12 MB of
rebuildable binary and would sit in git history forever).

**Download:** https://github.com/joaoalbuq/Hermes-Androidapp/releases/download/v1.3/hermes-mobile-1.3-debug.apk

- applicationId `com.hermesmobile.viewer`, versionCode 4, versionName 1.3
- minSdk 26 (Android 8+), targetSdk 36
- 12,390,507 bytes
- sha256 `2055ba4796a871f4a3cc8257beedbbff5dadd6fc5174287a8c3c633c091744f1`
- Debug-signed with this machine's Android debug key (same cert as 1.0–1.2, so it
  installs in place), personal use, not for distribution.

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
