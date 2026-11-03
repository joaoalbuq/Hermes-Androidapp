import type { Credential } from './types'
import { resolveBaseUrl } from '../../config'

/**
 * URL handling for gateway connections.
 *
 * The Desktop's "Remote gateway" connection kind is a base URL plus a token, and
 * reverse-proxy path prefixes must survive: a gateway served at
 * https://host/hermes answers its WebSocket at /hermes/api/ws. Per-profile routes
 * may add another prefix (/p/<profile>/), which is just more path.
 */

/** Trim, default the scheme, and drop trailing slashes / query / hash. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) throw new Error('Gateway URL is empty')
  let candidate = trimmed
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Gateway URL must start with http:// or https://')
  }
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

/**
 * ws(s)://<prefix>/api/ws?token=… | ?ticket=…
 *
 * The credential travels as a query parameter because the gateway's WS upgrade
 * only reads it there (hermes_cli/web_server_chat.py::_ws_auth_reason); a browser
 * WebSocket cannot set the X-Hermes-Session-Token header anyway. Query strings can
 * land in proxy logs, so prefer TLS — see README.
 *
 * A `ticket` is one-use and expires in 30 s, so callers must build this URL
 * immediately before dialling — never cache it.
 */
export function buildWsUrl(baseUrl: string, credential: Credential | string): string {
  const url = new URL(normalizeBaseUrl(resolveBaseUrl(baseUrl)))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  // A root URL still reports pathname '/', so join against the empty prefix —
  // otherwise the dial becomes //api/ws and a proxy (or the parsed request line)
  // reads the doubled slash as an authority.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/ws`
  const resolved: Credential =
    typeof credential === 'string' ? { kind: 'token', value: credential } : credential
  if (resolved?.value) {
    url.searchParams.set(resolved.kind === 'ticket' ? 'ticket' : 'token', resolved.value)
  }
  return url.toString()
}

/** The HTTP leg: GET <prefix>/api/status. */
export function buildStatusUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(resolveBaseUrl(baseUrl))}/api/status`
}

/** Where a human should look when a leg fails. */
export function describeHost(baseUrl: string): string {
  try {
    const u = new URL(normalizeBaseUrl(baseUrl))
    return `${u.host}${u.pathname}`
  } catch {
    return baseUrl
  }
}
