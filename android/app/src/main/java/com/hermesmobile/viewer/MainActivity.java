package com.hermesmobile.viewer;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before the bridge starts, or the JS side resolves
        // "Downloads" / "KeepAlive" to unimplemented plugins and every call fails.
        registerPlugin(DownloadsPlugin.class);
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
