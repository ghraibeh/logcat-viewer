# The native receiver looks these up by name via JNI (RegisterNatives is not used).
-keep class com.mobilelabkit.airplay.NativeReceiver { *; }
-keep interface com.mobilelabkit.airplay.NativeReceiver$Listener { *; }
