# Hermes Mobile — installable APK

The build lives in the GitHub release, not in the repo (a debug APK is 12 MB of
rebuildable binary and would sit in git history forever).

**Download:** https://github.com/joaoalbuq/Hermes-Androidapp/releases/download/v1.0/hermes-mobile-1.0-debug.apk

- applicationId `com.hermesmobile.viewer`, versionCode 1, versionName 1.0
- minSdk 26 (Android 8+), targetSdk 36
- sha256 `c17cb3f7ae631b1c71148647fba1528ae8740893381bb8f012015841897c26a5`
- Debug-signed: personal use, not for distribution.

Install on the phone: open that link on the device, allow "install unknown apps"
for the browser or Files app you downloaded it with, then open the file.

Uninstall any earlier build first — debug APKs are signed with a fresh key, so
Android reports a bare "App not installed" instead of upgrading.

Rebuild from source with `bash scripts/build-apk.sh` (see the repo README).
