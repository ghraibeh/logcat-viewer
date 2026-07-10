package com.logcatviewer.mocklocation;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Criteria;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Foreground service that pushes a mock GPS coordinate to the OS.
 *
 * <p>It is driven entirely over adb by the Mac app:
 * <pre>
 *   am start-foreground-service -n com.logcatviewer.mocklocation/.MockService \
 *      --es cmd set --es lat 37.4219983 --es lng -122.084 [--es acc 5] [--es alt 0]
 *   am start-foreground-service -n com.logcatviewer.mocklocation/.MockService --es cmd stop
 * </pre>
 *
 * <p>lat/lng are passed as <b>strings</b> (not {@code --ef}) so full double
 * precision survives; {@code --ef} is a 32-bit float and loses ~2 decimals of
 * latitude precision.
 *
 * <p>Uses the long-lived {@link LocationManager#addTestProvider} overload so a
 * single code path works from API 21 through the latest Android.
 */
public class MockService extends Service {
    static final String TAG = "MockLocation";
    static final String CHANNEL = "mocklocation";
    static final int NOTIF_ID = 0x10C;
    static final long TICK_MS = 1000L;   // re-publish so apps always see a fresh fix

    private LocationManager lm;
    private Handler handler;
    private Runnable ticker;
    private final List<String> providers = new ArrayList<>();
    private boolean running = false;

    private volatile double lat = 0, lng = 0, alt = 0, acc = 5;

    @Override
    public void onCreate() {
        super.onCreate();
        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        handler = new Handler(Looper.getMainLooper());
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // startForegroundService() requires startForeground() promptly; do it first.
        startForegroundCompat();

        String cmd = intent != null ? intent.getStringExtra("cmd") : null;
        if ("stop".equals(cmd)) {
            stopMocking();
            // Removing the test providers hands control back to the real GPS, but the
            // OS keeps serving the *last mock fix* from its last-known cache until a
            // fresh real fix arrives. Actively re-acquire one so we snap back to the
            // real location immediately, then shut down.
            restoreRealLocation(new Runnable() {
                @Override public void run() {
                    stopForeground(true);
                    stopSelf();
                }
            });
            return START_NOT_STICKY;
        }

        // "set" (default): parse the target and (re)start publishing.
        if (intent != null) {
            try {
                lat = Double.parseDouble(intent.getStringExtra("lat"));
                lng = Double.parseDouble(intent.getStringExtra("lng"));
            } catch (Exception e) {
                Log.e(TAG, "set: missing/invalid lat/lng", e);
                return START_STICKY;
            }
            alt = parseOr(intent.getStringExtra("alt"), alt);
            acc = parseOr(intent.getStringExtra("acc"), acc);
        }

        ensureProviders();
        Log.i(TAG, "mocking " + lat + ", " + lng + "  (acc=" + acc + "m, alt=" + alt + ")");
        startTicker();
        return START_STICKY;
    }

    private static double parseOr(String s, double fallback) {
        if (s == null) return fallback;
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    // --- test providers ----------------------------------------------------
    private void ensureProviders() {
        if (running) return;
        providers.clear();
        addProvider(LocationManager.GPS_PROVIDER);
        addProvider(LocationManager.NETWORK_PROVIDER);
        // "fused" test provider exists from API 31 (LocationManager.FUSED_PROVIDER).
        if (Build.VERSION.SDK_INT >= 31) addProvider("fused");
        running = true;
    }

    private void addProvider(String name) {
        try {
            try { lm.removeTestProvider(name); } catch (Exception ignore) { /* not registered yet */ }
            lm.addTestProvider(
                    name,
                    false, false, false, false,   // requiresNetwork/Satellite/Cell, hasMonetaryCost
                    true, true, true,             // supportsAltitude, supportsSpeed, supportsBearing
                    Criteria.POWER_LOW, Criteria.ACCURACY_FINE);
            lm.setTestProviderEnabled(name, true);
            providers.add(name);
        } catch (SecurityException e) {
            // Not selected as the mock-location app — the Mac app grants this via
            // `appops set ... android:mock_location allow` before starting us.
            Log.e(TAG, "addTestProvider(" + name + ") denied — not the mock location app", e);
        } catch (Exception e) {
            Log.w(TAG, "addTestProvider(" + name + ") failed: " + e);
        }
    }

    private void startTicker() {
        stopTicker();
        ticker = new Runnable() {
            @Override public void run() {
                push();
                handler.postDelayed(this, TICK_MS);
            }
        };
        handler.post(ticker);
    }

    private void stopTicker() {
        if (ticker != null) {
            handler.removeCallbacks(ticker);
            ticker = null;
        }
    }

    private void push() {
        for (String name : providers) {
            Location loc = new Location(name);
            loc.setLatitude(lat);
            loc.setLongitude(lng);
            loc.setAltitude(alt);
            loc.setAccuracy((float) acc);
            loc.setBearing(0f);
            loc.setSpeed(0f);
            loc.setTime(System.currentTimeMillis());
            loc.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
            // Modern Android rejects "incomplete" locations without these accuracies.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                loc.setVerticalAccuracyMeters((float) acc);
                loc.setBearingAccuracyDegrees(0.1f);
                loc.setSpeedAccuracyMetersPerSecond(0.01f);
            }
            try {
                lm.setTestProviderLocation(name, loc);
            } catch (Exception e) {
                Log.w(TAG, "setTestProviderLocation(" + name + ") failed: " + e);
            }
        }
    }

    private void stopMocking() {
        stopTicker();
        for (String name : providers) {
            try { lm.setTestProviderEnabled(name, false); } catch (Exception ignore) {}
            try { lm.removeTestProvider(name); } catch (Exception ignore) {}
        }
        providers.clear();
        running = false;
        Log.i(TAG, "mock stopped");
    }

    /**
     * Ask the real providers for one fresh fix so the OS last-known cache stops
     * returning the stale mock coordinate. Calls {@code onDone} on the first real
     * fix, or after a short timeout if none arrives (e.g. location services off /
     * no signal indoors) — either way we then shut the service down.
     */
    private void restoreRealLocation(final Runnable onDone) {
        updateNotification("Restoring real location", "Reacquiring the device's real GPS location…");

        final boolean[] finished = {false};
        final LocationListener[] listenerRef = new LocationListener[1];
        final Runnable finish = new Runnable() {
            @Override public void run() {
                if (finished[0]) return;
                finished[0] = true;
                if (listenerRef[0] != null) {
                    try { lm.removeUpdates(listenerRef[0]); } catch (Exception ignore) {}
                }
                onDone.run();
            }
        };
        final LocationListener listener = new LocationListener() {
            @Override public void onLocationChanged(Location loc) {
                if (finished[0] || loc == null || isMock(loc)) return;   // ignore the stale mock cache
                Log.i(TAG, "real location restored: " + loc.getLatitude() + ", "
                        + loc.getLongitude() + " (" + loc.getProvider() + ")");
                finish.run();
            }
            // No-op overrides kept for compatibility with older API levels.
            @Override public void onStatusChanged(String p, int s, Bundle b) {}
            @Override public void onProviderEnabled(String p) {}
            @Override public void onProviderDisabled(String p) {}
        };
        listenerRef[0] = listener;

        // "fused" (API 31+) is the modern aggregate and most likely to have data;
        // also try network (wifi/cell — fast) and gps.
        List<String> ask = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) ask.add("fused");
        ask.add(LocationManager.NETWORK_PROVIDER);
        ask.add(LocationManager.GPS_PROVIDER);

        boolean requested = false;
        for (final String name : ask) {
            try {
                if (!lm.isProviderEnabled(name)) continue;
                requested = true;
                // Keep listening until a real fix lands (or we time out).
                lm.requestLocationUpdates(name, 0L, 0f, listener, Looper.getMainLooper());
                // Also fire a one-shot active request — this can force wifi/cell to
                // compute a fresh position rather than wait for a passive update.
                if (Build.VERSION.SDK_INT >= 30) {
                    lm.getCurrentLocation(name, null, getMainExecutor(),
                            new java.util.function.Consumer<Location>() {
                        @Override public void accept(Location loc) {
                            if (finished[0] || loc == null || isMock(loc)) return;
                            Log.i(TAG, "real location restored: " + loc.getLatitude() + ", "
                                    + loc.getLongitude() + " (" + name + ")");
                            finish.run();
                        }
                    });
                }
            } catch (Exception e) {
                Log.w(TAG, "restore request(" + name + "): " + e);
            }
        }

        final boolean req = requested;
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                if (finished[0]) return;
                // The mock override is already gone; there's just no real fix to be
                // had right now (no signal / indoors). Real location resumes on its
                // own the moment the device acquires a fix.
                Log.i(TAG, req ? "restore: no real fix yet — real location resumes when the device gets one"
                              : "restore: no location provider enabled");
                finish.run();
            }
        }, 12000);
    }

    private static boolean isMock(Location loc) {
        try {
            return Build.VERSION.SDK_INT >= 31 ? loc.isMock() : loc.isFromMockProvider();
        } catch (Exception e) {
            return false;
        }
    }

    // --- foreground plumbing ----------------------------------------------
    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Mock Location", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @SuppressWarnings("deprecation")
    private Notification buildNotification(String title, String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .build();
    }

    private void startForegroundCompat() {
        Notification n = buildNotification(
                "Mock location active", "Logcat Viewer is providing a mock GPS location");
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void updateNotification(String title, String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(title, text));
    }

    @Override
    public void onDestroy() {
        stopMocking();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
