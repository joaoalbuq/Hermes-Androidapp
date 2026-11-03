# Hermes Mobile — installable APK

The build lives in the GitHub release, not in the repo (a debug APK is 12 MB of
rebuildable binary and would sit in git history forever).

**Download:** https://github.com/joaoalbuq/Hermes-Androidapp/releases/download/v1.1/hermes-mobile-1.1-debug.apk

- applicationId `com.hermesmobile.viewer`, versionCode 2, versionName 1.1
- minSdk 26 (Android 8+), targetSdk 36
- 12,376,927 bytes
- sha256 `c7c87978a42d1bc59d7d44f4a9975012907eccae54bb235b2071cf8d85b601b0`
- Debug-signed with this machine's Android debug key (same cert as 1.0, so it
  installs in place over an earlier build), personal use, not for distribution.

## What 1.1 fixes

A bot's chat could not be opened — the roster reported `could not attach: session
not found`. Three protocol details were wrong:

- `profiles.list` carries each chat's durable id under `last_session.id`; the app
  read `session_id` and got nothing, so it fell through to an id from the wrong
  profile home.
- Stored chats need `session.resume`, not `session.activate` (which only attaches
  to a session that is already live). The app now tries `resume` first and falls
  back to `activate`.
- `session.resume` mints a new **runtime** id per attach. That handle is what
  events and `prompt.submit` address, but it is dead the moment the socket
  closes, so it must never be the id remembered for next launch. The app now
  keeps the durable id as the chat's identity and hangs the runtime handle off it.

A stale remembered id is no longer a dead end either: the app forgets it and
falls back to the bot's roster chat, then to the newest chat in its list.

## Install

Open that link on the phone, allow "install unknown apps" for the browser or
Files app you downloaded it with, then open the file. On 1.0 it upgrades in
place and keeps your connection and sign-in.

Rebuild from source with `bash scripts/build-apk.sh` (see the repo README).
