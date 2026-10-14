# LookCam phone bridge

This app runs on the Android phone that is the camera's Wi-Fi hotspot. The camera stays on the phone hotspot. The phone reaches the operator console over mobile data or an upstream Wi-Fi connection.

The screen shows only start, stop, and four status lines. Failure detail is written to a private log, not to the main screen.

## Daily use

1. Turn on the phone hotspot and join the camera to it.
2. Open LookCam Bridge.
3. Open Connection settings once and enter the console URL, bridge token, and camera id (`GHBB-522328-BWDTT`). Leave camera IP empty unless you want to pin one.
4. Tap **Keep running in background** and allow it.
5. Tap **Start bridge**. The notification stays up while the phone is locked.

Stop and start again after changing the token or camera id.

## What the phone does

It searches the hotspot in four ways at once: the last camera address, the subnet broadcast, the neighbor table when Android allows it, and a direct probe of every address on the hotspot `/24`. The first camera reply becomes the session. Video bytes are uploaded to `/api/bridge/h264`. Commands come from `/api/bridge/poll`.

The bridge token and camera password are not written to the log. The password is delivered by the console after the phone connects.

## If it fails

Tap **Export debug bundle** and share the text file. It contains the hotspot interfaces the phone could see, the search result, session resets, skipped video gaps, and HTTP status codes. The token is removed before the file is written.

The same file is on the phone at:

`/data/data/com.operator.bridge/files/logs/bridge-debug.log`

```bash
adb shell run-as com.operator.bridge cat files/logs/bridge-debug.log
```

## Build

A full JDK 17 or newer is required (`jlink` must be on `PATH`; a JRE is not enough). GitHub Actions builds `app-debug.apk` from this folder. Locally:

```bash
cd android_bridge
./gradlew assembleDebug
```

Install `app/build/outputs/apk/debug/app-debug.apk`. The token is typed into the app. It is not stored in this repository.
