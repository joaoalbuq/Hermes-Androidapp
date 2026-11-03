# Hermes Mobile — installable APK

The build lives in the GitHub release, not in the repo (a debug APK is 12 MB of
rebuildable binary and would sit in git history forever).

**Download:** https://github.com/joaoalbuq/Hermes-Androidapp/releases/download/v1.2/hermes-mobile-1.2-debug.apk

- applicationId `com.hermesmobile.viewer`, versionCode 3, versionName 1.2
- minSdk 26 (Android 8+), targetSdk 36
- 12,384,079 bytes
- sha256 `3c99e3da4d512acbcd7faae0a9e21d08b24cca3e4144c0e8c4e484c2756c3484`
- Debug-signed with this machine's Android debug key (same cert as 1.0/1.1, so it
  installs in place), personal use, not for distribution.

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
