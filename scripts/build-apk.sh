#!/usr/bin/env bash
# Build the debug APK with the project-local toolchain.
#   bash scripts/build-apk.sh
# Produces android/app/build/outputs/apk/debug/app-debug.apk
set -u
cd "$(dirname "$0")/.." || exit 1

# Gradle is a Windows-native Java process: it needs C:/... paths, not MSYS /c/...
# (and the project path contains a space, which is why these are quoted properties).
WINROOT="$(cygpath -m "$(pwd)")"

export JAVA_HOME="$WINROOT/.toolchain/jdk-extract/jdk-21.0.13.0.2+1"
export ANDROID_HOME="$WINROOT/.toolchain/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export PATH

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "JDK missing. Run: bash scripts/fetch-toolchain.sh"
  exit 2
fi
if [ ! -d "$ANDROID_HOME/platforms/android-36" ]; then
  echo "Android platform 36 missing. Run: bash scripts/install-sdk.sh"
  exit 2
fi

# Gradle needs the SDK location, and the path contains a space, so write it as a
# property rather than exporting a path Gradle would parse.
printf 'sdk.dir=%s\n' "$(pwd)/.toolchain/android-sdk" > android/local.properties

echo "web assets: building dist/"
npm run build || exit 3
npx cap sync android || exit 3

echo "gradle: assembleDebug"
cd android || exit 3
./gradlew --no-daemon assembleDebug
status=$?

cd ..
if [ $status -ne 0 ]; then
  echo "GRADLE_FAILED"
  exit 4
fi

APK="android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  echo "APK_BUILT"
  ls -l "$APK"
  sha256sum "$APK"
fi
