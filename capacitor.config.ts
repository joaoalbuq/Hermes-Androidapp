import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Android packaging.
 *
 * Two settings here are load-bearing for talking to a real Hermes gateway:
 *
 * 1. `server.androidScheme: 'capacitor'`
 *    The gateway's WebSocket upgrade applies an Origin gate
 *    (hermes_cli/web_server_boundary.py::ws_host_origin_reason). An http(s)
 *    Origin must name the very host:port being dialled, so a WebView running on
 *    the default https://localhost would be rejected with close code 4403
 *    (origin_mismatch). A NON-web scheme is trusted outright, so the app must
 *    load from capacitor://localhost.
 *
 * 2. `server.cleartext: true` + `android.allowMixedContent: true`
 *    Lets you point the app at a plain http:// gateway on a LAN/Tailscale IP.
 *    If your gateway is behind TLS, leave cleartext alone and use https:// URLs.
 *
 * NO `server.url` — the web bundle is bundled inside the APK. The gateway URL is
 * runtime configuration on the Settings screen, never a build input.
 */
const config: CapacitorConfig = {
  appId: 'com.hermesmobile.viewer',
  appName: 'Hermes Mobile',
  webDir: 'dist',
  server: {
    androidScheme: 'capacitor',
    cleartext: true,
  },
  plugins: {
    // Native HTTP for the sign-in + ticket legs: the gateway's CORS allowlist
    // names its own dashboard origins, so a WebView fetch from
    // capacitor://localhost cannot read the login response.
    CapacitorHttp: {
      enabled: true,
    },
  },
  android: {
    allowMixedContent: true,
  },
}

export default config
