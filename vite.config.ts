import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev-only gateway proxy.
 *
 * A desktop browser cannot talk to the gateway directly: its CORS preflight allows
 * the origin but omits `Access-Control-Allow-Credentials`, so a credentialed fetch
 * is dropped before the status code is readable — every request looks like
 * "failed to fetch". Proxying through the dev server makes those requests
 * same-origin, so `npm run dev` can actually exercise sign-in.
 *
 * The app itself never uses this: on Android everything goes through
 * CapacitorHttp and the real gateway URL. Keep the target in sync with
 * DEFAULT_GATEWAY_URL in src/config.ts (or override with HERMES_DEV_GATEWAY).
 */
const DEV_GATEWAY = (process.env.HERMES_DEV_GATEWAY || 'https://hermes-agent-whz6.srv2007716.hstgr.cloud').replace(
  /\/+$/,
  '',
)

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // The APK ships this bundle; keep it self-contained and inspectable.
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    proxy: {
      '/gateway': {
        target: DEV_GATEWAY,
        changeOrigin: true,
        secure: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/gateway/, ''),
        // The gateway's WS upgrade refuses an http(s) Origin that does not name
        // the host being dialled (close 4403), so present the gateway's own origin
        // rather than localhost's.
        configure: (proxy) => {
          const fixOrigin = (request: { setHeader: (name: string, value: string) => void }) => {
            request.setHeader('origin', DEV_GATEWAY)
          }
          proxy.on('proxyReq', fixOrigin)
          proxy.on('proxyReqWs', fixOrigin)
        },
      },
    },
  },
})
