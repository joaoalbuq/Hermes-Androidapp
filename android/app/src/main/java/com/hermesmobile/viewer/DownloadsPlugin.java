package com.hermesmobile.viewer;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Saves bytes handed over from the web layer into the phone's public Downloads
 * folder, so a file the agent produced ends up where the user can find it.
 *
 * <p>Two paths, because minSdk is 26 and scoped storage arrived in 29:
 * on API 29+ the row is inserted through MediaStore (no permission needed and
 * the file is visible to Files/Downloads straight away); below that the legacy
 * public DIRECTORY_DOWNLOADS is written directly, which needs
 * WRITE_EXTERNAL_STORAGE on those releases only.
 *
 * <p>The web layer fetches the bytes itself — it already holds the gateway
 * session cookie — so this plugin never does network I/O. That keeps the
 * authentication story in one place.
 */
@CapacitorPlugin(
        name = "Downloads",
        permissions = {
            @Permission(
                    alias = "storage",
                    strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
        })
public class DownloadsPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename");
        String mime = call.getString("mime", "application/octet-stream");
        String base64 = call.getString("base64");

        if (filename == null || filename.trim().isEmpty()) {
            call.reject("filename is required");
            return;
        }
        if (base64 == null || base64.isEmpty()) {
            call.reject("base64 is required");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException err) {
            call.reject("bad base64 payload");
            return;
        }

        String safeName = sanitise(filename);

        // Only the pre-Q path touches foreign storage, so only it asks.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermission");
            return;
        }
        write(call, safeName, mime, bytes);
    }

    @PermissionCallback
    private void storagePermission(PluginCall call) {
        if (getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Storage permission is needed to save into Downloads on this Android version");
            return;
        }
        String filename = call.getString("filename");
        String mime = call.getString("mime", "application/octet-stream");
        String base64 = call.getString("base64");
        write(call, sanitise(filename == null ? "download" : filename), mime,
                Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT));
    }

    private void write(PluginCall call, String safeName, String mime, byte[] bytes) {
        try {
            JSObject result = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? saveWithMediaStore(safeName, mime, bytes)
                    : saveToLegacyDownloads(safeName, mime, bytes);
            if (result == null) {
                call.reject("could not write to Downloads");
                return;
            }
            call.resolve(result);
        } catch (Exception err) {
            call.reject("could not write to Downloads: " + err.getMessage(), err);
        }
    }

    /** API 29+: insert into the Downloads collection, nobody needs WRITE_EXTERNAL_STORAGE. */
    private JSObject saveWithMediaStore(String name, String mime, byte[] bytes) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) return null;

        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) {
                resolver.delete(uri, null, null);
                return null;
            }
            out.write(bytes);
            out.flush();
        } catch (Exception err) {
            resolver.delete(uri, null, null);
            throw err;
        }

        // Publishing the row is what makes it show up in Downloads.
        ContentValues done = new ContentValues();
        done.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(uri, done, null, null);

        JSObject result = new JSObject();
        result.put("uri", uri.toString());
        result.put("name", name);
        result.put("location", "Downloads");
        result.put("bytes", bytes.length);
        return result;
    }

    /** API 26-28: plain write into /sdcard/Download, then tell the media scanner. */
    private JSObject saveToLegacyDownloads(String name, String mime, byte[] bytes) throws Exception {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) return null;
        if (!dir.exists() && !dir.mkdirs()) return null;

        File target = uniqueFile(dir, name);
        try (FileOutputStream out = new FileOutputStream(target)) {
            out.write(bytes);
            out.flush();
        }
        MediaScannerConnection.scanFile(
                getContext(), new String[] { target.getAbsolutePath() }, new String[] { mime }, null);

        JSObject result = new JSObject();
        result.put("uri", Uri.fromFile(target).toString());
        result.put("name", target.getName());
        result.put("location", "Downloads");
        result.put("bytes", bytes.length);
        return result;
    }

    /** "report (2).pdf" instead of silently overwriting a previous download. */
    private File uniqueFile(File dir, String name) {
        File candidate = new File(dir, name);
        if (!candidate.exists()) return candidate;

        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int index = 2; index < 1000; index++) {
            candidate = new File(dir, stem + " (" + index + ")" + ext);
            if (!candidate.exists()) return candidate;
        }
        return new File(dir, stem + "-" + System.currentTimeMillis() + ext);
    }

    /** Strip path separators and control characters before handing the name to storage. */
    private String sanitise(String raw) {
        String name = raw.trim().replace('\\', '_').replace('/', '_');
        StringBuilder out = new StringBuilder(name.length());
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            out.append(c < 0x20 || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|'
                    ? '_'
                    : c);
        }
        String cleaned = out.toString().trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) {
            return "download-" + System.currentTimeMillis();
        }
        return cleaned.length() > 120 ? cleaned.substring(0, 120) : cleaned;
    }

    @SuppressWarnings("unused")
    private Context context() {
        return getContext();
    }
}
