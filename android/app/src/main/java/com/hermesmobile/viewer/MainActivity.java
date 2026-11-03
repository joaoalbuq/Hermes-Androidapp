package com.hermesmobile.viewer;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before the bridge starts, or the JS side resolves
        // "Downloads" to an unimplemented plugin and every save fails.
        registerPlugin(DownloadsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
