package com.hermesmobile.viewer;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Start/stop the foreground service that holds the gateway socket open while the
 * app is backgrounded, and report whether Android is still free to freeze us
 * (battery optimisation).
 */
@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {

    private static final String ALERTS_CHANNEL_ID = "hermes-alerts";
    private static final int NOTIFICATION_REQUEST = 4712;

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, KeepAliveService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException err) {
            // Android 12+ refuses a foreground start from the background; the JS
            // side retries on the next resume, so report instead of crashing.
            call.reject("could not start the connection service: " + err.getMessage());
            return;
        }
        JSObject result = new JSObject();
        result.put("running", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        context.stopService(new Intent(context, KeepAliveService.class));
        JSObject result = new JSObject();
        result.put("running", false);
        call.resolve(result);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", KeepAliveService.running);
        result.put("exempt", isExemptFromBatteryOptimisation());
        result.put("notifications", canNotify());
        call.resolve(result);
    }

    /**
     * Post a local notification — the app telling you a turn finished while you
     * were not looking at it. Distinct from the ongoing foreground-service
     * notification, which is the connection itself.
     */
    @PluginMethod
    public void notify(PluginCall call) {
        String title = call.getString("title", "Hermes");
        String body = call.getString("body", "");
        Integer rawId = call.getInt("id", 5000);
        int id = rawId == null ? 5000 : rawId;

        requestNotificationPermissionIfNeeded();

        Context context = getContext();
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            call.reject("no notification service on this device");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    ALERTS_CHANNEL_ID, "Chat alerts", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("A turn finished or the agent is waiting for an answer.");
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                context,
                id,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, ALERTS_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(contentIntent);

        try {
            manager.notify(id, builder.build());
        } catch (SecurityException err) {
            // Android 13+ without POST_NOTIFICATIONS: the turn is still in the app.
            JSObject result = new JSObject();
            result.put("posted", false);
            result.put("permission", false);
            call.resolve(result);
            return;
        }
        JSObject result = new JSObject();
        result.put("posted", true);
        result.put("permission", canNotify());
        call.resolve(result);
    }

    /** Ask once for POST_NOTIFICATIONS (Android 13+) if the user has not answered. */
    @PluginMethod
    public void requestNotifications(PluginCall call) {
        requestNotificationPermissionIfNeeded();
        JSObject result = new JSObject();
        result.put("notifications", canNotify());
        call.resolve(result);
    }

    private boolean canNotify() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (canNotify()) return;
        Activity activity = getActivity();
        if (activity == null) return;
        ActivityCompat.requestPermissions(
                activity, new String[] {Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
    }

    /**
     * Ask Android to stop freezing the app. Without this, Doze can still cut the
     * socket after a long lock even with the service running.
     */
    @PluginMethod
    public void requestExemption(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            result.put("exempt", true);
            call.resolve(result);
            return;
        }
        if (isExemptFromBatteryOptimisation()) {
            result.put("exempt", true);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (RuntimeException err) {
            // Some ROMs have no such activity; open the battery-optimisation list
            // instead so the setting is still reachable.
            try {
                getContext().startActivity(
                        new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (RuntimeException ignored) {
                call.reject("this device has no battery-optimisation settings screen");
                return;
            }
        }
        result.put("exempt", isExemptFromBatteryOptimisation());
        call.resolve(result);
    }

    private boolean isExemptFromBatteryOptimisation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (power == null) return true;
        return power.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }
}
