#!/usr/bin/env bash
# Install the Android SDK packages this project compiles against, into the
# project-local .toolchain/android-sdk. Needs the JDK fetched by fetch-toolchain.sh.
#
# sdkmanager.bat cannot be used as-is: this project's path contains a space
# ("joao albuquerque") and the wrapper's quoting falls apart, so the command line
# is built by hand exactly as the .bat does it.
set -u
cd "$(dirname "$0")/.." || exit 1

export JAVA_HOME="$(pwd)/.toolchain/jdk-extract/jdk-21.0.13.0.2+1"
export ANDROID_HOME="$(pwd)/.toolchain/android-sdk"
TOOLS="$ANDROID_HOME/cmdline-tools/latest"
JAVA="$JAVA_HOME/bin/java"
CP="$TOOLS/lib/sdkmanager-classpath.jar"

sdkmanager() {
  "$JAVA" -classpath "$CP" com.android.sdklib.tool.sdkmanager.SdkManagerCli \
    --sdk_root="$ANDROID_HOME" "$@"
}

if [ ! -f "$CP" ]; then
  echo "sdkmanager classpath missing at $CP"
  exit 2
fi

echo "sdkmanager version:"
sdkmanager --version || exit 3

echo "accepting licenses"
yes | sdkmanager --licenses >/tmp/sdk-licenses.log 2>&1
echo "licenses exit=$?"

echo "installing packages"
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
echo "sdkmanager exit=$?"

echo "SDK_INSTALL_DONE"
