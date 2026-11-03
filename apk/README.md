# Hermes Mobile — installable APK

`hermes-mobile-1.0-debug.apk` is a **debug-signed** build (personal use, not for
distribution). applicationId `com.hermesmobile.viewer`, versionCode 1,
minSdk 26, targetSdk 36.

To install on the phone: open this file on the device (GitHub mobile → this
folder → the .apk → Download), then allow "install unknown apps" for whichever
app you downloaded it with.

Uninstall any earlier build first — debug APKs are signed with a fresh key on a
different machine, so Android reports a bare "App not installed" instead of
upgrading.
