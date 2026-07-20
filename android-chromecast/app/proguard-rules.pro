# Phase 2 (native openscreen bridge) will look these up by name via JNI — keep them.
-keep class com.mobilelabkit.chromecast.NativeReceiver { *; }
-keep interface com.mobilelabkit.chromecast.NativeReceiver$Listener { *; }
