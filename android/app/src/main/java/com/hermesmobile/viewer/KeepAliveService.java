package com.hermesmobile.viewer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Keeps the gateway socket alive while the phone is locked.
 *
 * The app is a WebView, and Android freezes a backgrounded process: its timers
 * stop, the heartbeat never fires, and the WebSocket dies without the page ever
 * learning about it — which is why a locked phone used to come back to a chat
 * that had stopped updating. A foreground service with a partial wake lock and a
 * high-performance Wi-Fi lock keeps the process (and therefore the JS event loop
 * and the socket) running, so turns keep streaming into the transcript while the
 * screen is off.
 *
 * The notification is not decoration: Android requires one for a foreground
 * service, and it doubles as the honest indicator that the connection is live.
 */
public class KeepAliveService extends Service {
    static final String CHANNEL_ID = "hermes-connection";
    static final int NOTIFICATION_ID = 4711;
    static final String ACTION_STOP = "com.hermesmobile.viewer.KEEPALIVE_STOP";

    /** Read by the plugin: is the connection being held open right now? */
    static boolean running = false;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();

        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power != null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hermes:gateway");
            wakeLock.setReferenceCounted(false);
        }
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hermes:gateway");
            wifiLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        running = true;

        // START_STICKY: if Android does kill us for memory, it restarts the
        // service, and the page reloads into a fresh dial rather than staying dead.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel =
                new NotificationChannel(CHANNEL_ID, "Gateway connection", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while the phone keeps a Hermes conversation connected.");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, flags);

        Intent stop = new Intent(this, KeepAliveService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Hermes is connected")
                .setContentText("Chat keeps updating while the app is in the background.")
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setOngoing(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(contentIntent)
                .addAction(0, "Disconnect", stopIntent)
                .build();
    }
}
