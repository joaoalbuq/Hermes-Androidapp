package com.hermesmobile.viewer;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

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
        call.resolve(result);
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
