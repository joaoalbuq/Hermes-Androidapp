#!/usr/bin/env bash
# Bootstrap a project-local JDK + Android SDK so the APK can be built without
# touching anything outside this folder.
set -u
cd "$(dirname "$0")/.." || exit 1
TC=".toolchain"
mkdir -p "$TC"

JDK_ZIP="$TC/jdk.zip"
JDK_URL="https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip"
CLT_ZIP="$TC/cmdline-tools.zip"
CLT_URL="https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"

echo "[1/4] downloading JDK 21"
if [ ! -f "$JDK_ZIP" ]; then
  curl -L --fail --retry 3 -o "$JDK_ZIP" "$JDK_URL" || { echo "JDK download failed"; exit 2; }
fi

echo "[2/4] extracting JDK"
if [ ! -d "$TC/jdk" ]; then
  mkdir -p "$TC/jdk-extract"
  unzip -q -o "$JDK_ZIP" -d "$TC/jdk-extract" || { echo "JDK extract failed"; exit 2; }
  inner=$(find "$TC/jdk-extract" -maxdepth 1 -mindepth 1 -type d | head -1)
  mv "$inner" "$TC/jdk"
  rmdir "$TC/jdk-extract" 2>/dev/null
fi
"$TC/jdk/bin/java" -version 2>&1 | head -2

echo "[3/4] downloading Android command-line tools"
if [ ! -f "$CLT_ZIP" ]; then
  curl -L --fail --retry 3 -o "$CLT_ZIP" "$CLT_URL" || { echo "cmdline-tools download failed"; exit 2; }
fi

echo "[4/4] extracting command-line tools"
mkdir -p "$TC/android-sdk/cmdline-tools"
if [ ! -d "$TC/android-sdk/cmdline-tools/latest" ]; then
  rm -rf "$TC/clt-extract"
  mkdir -p "$TC/clt-extract"
  unzip -q -o "$CLT_ZIP" -d "$TC/clt-extract" || { echo "cmdline-tools extract failed"; exit 2; }
  mv "$TC/clt-extract/cmdline-tools" "$TC/android-sdk/cmdline-tools/latest"
fi

echo "TOOLCHAIN_UNPACKED"
