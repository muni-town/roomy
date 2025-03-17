#!/usr/bin/env sh

# Install project using pnpm. Deno does not work for Tauri on android
pnpm install

# Generate icons
cargo tauri icon -o src-tauri/icons/ static/favicon.png

# Setup android build
# might be better to commit the files generated from this if running in CI
# 
# Required environment variables
# JAVA_HOME=/opt/android-studio/jbr
# ANDROID_HOME="$HOME/Android/Sdk"
# NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 $ANDROID_HOME/ndk)"
# 
cargo android init
