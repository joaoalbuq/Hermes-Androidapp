/**
 * The gateway this build is set up for.
 *
 * Only a starting value for the "New connection" form — the app still reads the
 * URL from saved connections at runtime, so any other gateway can be added from
 * Settings. Nothing here is a credential.
 */
export const DEFAULT_GATEWAY_URL = 'https://hermes-agent-whz6.srv2007716.hstgr.cloud'

export const DEFAULT_GATEWAY_NAME = 'Hermes online'

/** Same-origin prefix the dev server proxies to the gateway (see vite.config.ts). */
export const DEV_PROXY_PREFIX = '/gateway'

/**
 * Route the default gateway through the dev server's proxy when running in a
 * browser.
 *
 * A desktop browser cannot do this flow against the gateway directly: the
 * gateway's preflight allows the origin but omits Access-Control-Allow-Credentials,
 * so a credentialed fetch is blocked by the browser and every request looks like
 * "failed to fetch". In the app the same requests go through CapacitorHttp and
 * are unaffected, so this rewrite exists purely so `npm run dev` is testable.
 */
export function resolveBaseUrl(baseUrl: string): string {
  if (!import.meta.env.DEV) return baseUrl
  if (typeof window === 'undefined') return baseUrl
  if (baseUrl.replace(/\/+$/, '') !== DEFAULT_GATEWAY_URL) return baseUrl
  return `${window.location.origin}${DEV_PROXY_PREFIX}`
}
