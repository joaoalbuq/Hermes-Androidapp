import { Capacitor, CapacitorCookies, CapacitorHttp } from '@capacitor/core'
import { InAppBrowser, DefaultWebViewOptions } from '@capacitor/inappbrowser'
import type { Credential } from './types'
import { resolveBaseUrl } from '../../config'

/**
 * Gated gateways ("remote" deployments) do not accept a static session token.
 *
 * The WebSocket upgrade reads its credential from `?token=` or `?ticket=`
 * (hermes_cli/web_server_chat.py::_ws_auth_reason):
 *
 *   loopback / --insecure : `?token=` compared to the dashboard session token
 *   gated (auth_required) : the in-process session token is never accepted; the
 *                           upgrade takes a one-use ticket from
 *                           `POST /api/auth/ws-ticket` (30 s TTL), or a token a
 *                           native sign-in minted. A password-provider gateway
 *                           (auth_required + basic) therefore has exactly one
 *                           path: sign in, mint a ticket, dial.
 *
 * Tickets are single-use and short-lived, so the credential is resolved freshly
 * for every dial — including reconnects.
 */

export type AuthMode = 'token' | 'password' | 'signin'

export interface PasswordAuth {
  username: string
  password: string
  /** Dashboard auth provider name; `basic` is "Username & Password". */
  provider: string
}

export const DEFAULT_PROVIDER = 'basic'

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

interface HttpResult {
  status: number
  data: unknown
  headers: Record<string, string>
}

function lowerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    }
  }
  return out
}

function networkMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    // The browser's opaque transport error. In a desktop browser this is almost
    // always CORS: the gateway answers the preflight but without
    // Access-Control-Allow-Credentials, so any credentialed request is dropped
    // before the status code is readable.
    return 'network error: the gateway could not be reached from this browser (CORS), or the host is down'
  }
  return `network error: ${message}`
}

/** Narrow the payload to something readable for an error line. */
function errorDetail(result: HttpResult): string {
  const data = result.data
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 160)
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const detail = record.detail ?? record.error ?? record.message ?? record.reason
    if (typeof detail === 'string') return detail
    if (detail) return JSON.stringify(detail).slice(0, 160)
  }
  return ''
}

/**
 * JSON over HTTP.
 *
 * On Android this goes through CapacitorHttp (the platform HTTP stack) rather
 * than fetch, because the gateway's CORS allowlist names its own dashboard
 * origins and a WebView running on capacitor://localhost is not one of them.
 * The login cookie is captured from Set-Cookie and replayed explicitly, so the
 * ticket request does not depend on a native cookie jar.
 */
async function httpJson(
  method: string,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...extraHeaders,
  }

  if (Capacitor.isNativePlatform()) {
    try {
      const res = await CapacitorHttp.request({
        url,
        method,
        headers,
        data: body,
        connectTimeout: 15_000,
        readTimeout: 25_000,
        responseType: 'json',
      })
      return { status: res.status, data: res.data, headers: lowerHeaders(res.headers) }
    } catch (err) {
      throw new AuthError(networkMessage(err))
    }
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'include',
    })
  } catch (err) {
    throw new AuthError(networkMessage(err))
  }
  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value
  })
  return { status: response.status, data, headers: responseHeaders }
}

/** `name=value` pairs from Set-Cookie, without attributes. */
function cookiePairs(headers: Record<string, string>): string {
  const raw = headers['set-cookie']
  if (!raw) return ''
  return raw
    .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

export function apiUrl(baseUrl: string, path: string): string {
  const base = resolveBaseUrl(baseUrl).replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * `POST /auth/password-login {provider, username, password}` -> session cookie.
 * Verified against a live gated gateway: 401 `{"detail":"Invalid credentials"}`
 * on bad input, 422 when `provider` is missing.
 */
export async function signIn(baseUrl: string, auth: PasswordAuth): Promise<string> {
  const result = await httpJson('POST', apiUrl(baseUrl, '/auth/password-login'), {
    provider: auth.provider || DEFAULT_PROVIDER,
    username: auth.username,
    password: auth.password,
  })
  if (result.status === 401 || result.status === 403) {
    throw new AuthError('Wrong username or password')
  }
  if (result.status === 404) {
    throw new AuthError('This gateway has no password sign-in (/auth/password-login)')
  }
  if (result.status >= 400) {
    throw new AuthError(`Sign-in refused (${result.status})${errorDetail(result) ? `: ${errorDetail(result)}` : ''}`)
  }
  return cookiePairs(result.headers)
}

/**
 * Mint a one-use WebSocket ticket with the login cookie.
 *
 * `/api/auth/ws-ticket` is the gated-mode route; `/api/webapp/socket-ticket` is
 * the Webapp's equivalent and is tried if the first one is absent.
 */
export async function mintTicket(baseUrl: string, cookie: string): Promise<string> {
  const headers: Record<string, string> = cookie ? { Cookie: cookie } : {}
  let result = await httpJson('POST', apiUrl(baseUrl, '/api/auth/ws-ticket'), {}, headers)
  if (result.status === 404) {
    result = await httpJson('POST', apiUrl(baseUrl, '/api/webapp/socket-ticket'), {}, headers)
  }
  if (result.status === 401 || result.status === 403) {
    throw new AuthError('Not signed in — the session cookie was rejected')
  }
  if (result.status >= 400) {
    throw new AuthError(`Ticket refused (${result.status})${errorDetail(result) ? `: ${errorDetail(result)}` : ''}`)
  }

  const data = result.data
  if (typeof data === 'string' && data.trim()) return data.trim()
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    for (const key of ['ticket', 'ws_ticket', 'wsTicket', 'token']) {
      const value = record[key]
      if (typeof value === 'string' && value) return value
    }
    // Some builds hand back the finished URL instead of the bare ticket.
    for (const key of ['url', 'ws_url', 'wsUrl']) {
      const value = record[key]
      if (typeof value === 'string' && value) {
        const ticket = new URL(value, baseUrl).searchParams.get('ticket')
        if (ticket) return ticket
      }
    }
  }
  throw new AuthError('Gateway returned no ticket')
}

/**
 * Holds the sign-in cookie, and mints a fresh ticket for every dial.
 * Re-signs in once when the cookie has expired.
 */
export class PasswordAuthSession {
  private cookie: string | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly auth: PasswordAuth,
  ) {}

  private async ensureCookie(force = false): Promise<string> {
    if (this.cookie && !force) return this.cookie
    this.cookie = await signIn(this.baseUrl, this.auth)
    // On native the platform cookie jar may hold the session without exposing
    // Set-Cookie to us; an empty string simply means "let the jar carry it".
    return this.cookie
  }

  /** Credential for one WebSocket dial. */
  async credential(): Promise<Credential> {
    const cookie = await this.ensureCookie()
    try {
      return { kind: 'ticket', value: await mintTicket(this.baseUrl, cookie) }
    } catch (err) {
      if (!(err instanceof AuthError)) throw err
      const fresh = await this.ensureCookie(true)
      return { kind: 'ticket', value: await mintTicket(this.baseUrl, fresh) }
    }
  }

  /** The HTTP leg: GET /api/status, authenticated with the same cookie. */
  async status(): Promise<HttpResult> {
    return httpJson('GET', apiUrl(this.baseUrl, '/api/status'), undefined, await this.httpHeaders())
  }

  /**
   * Cookie header for any other REST call on this gateway (file downloads).
   *
   * Gated gateways admit `/api/fs/*` with the sign-in cookie — the same session
   * the ticket is minted from — so nothing else has to be plumbed through.
   */
  async httpHeaders(): Promise<Record<string, string>> {
    const cookie = await this.ensureCookie()
    return cookie ? { Cookie: cookie } : {}
  }

  async signOut(): Promise<void> {
    this.cookie = null
  }
}

/**
 * Browser sign-in: the app opens the gateway's own /login in a WebView, the user
 * authenticates there, and the app keeps only the resulting session cookie. The
 * password is never seen by, or stored in, the app.
 *
 * This is the mode that survives a provider change: the login page is the
 * gateway's, so whatever it enables later (a password form, an OAuth portal) works
 * without touching this code. The ticket exchange afterwards is the same either
 * way.
 */
export class CookieAuthSession {
  constructor(
    private readonly baseUrl: string,
    private cookie: string,
  ) {}

  setCookie(cookie: string) {
    this.cookie = cookie
  }

  async credential(): Promise<Credential> {
    if (!this.cookie) throw new AuthError('Not signed in — open the gateway sign-in page')
    return { kind: 'ticket', value: await mintTicket(this.baseUrl, this.cookie) }
  }

  async status(): Promise<HttpResult> {
    return httpJson('GET', apiUrl(this.baseUrl, '/api/status'), undefined, await this.httpHeaders())
  }

  async httpHeaders(): Promise<Record<string, string>> {
    return this.cookie ? { Cookie: this.cookie } : {}
  }
}

/**
 * Read the session cookies the sign-in WebView left in the app's cookie jar.
 *
 * The InAppBrowser is opened with `isIsolated: false` for exactly this reason:
 * an isolated WebView (the plugin default) keeps its cookies in a separate
 * process and they are unreadable from here.
 */
export async function readGatewayCookies(baseUrl: string): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    throw new AuthError('Browser sign-in runs in the app, not a desktop browser')
  }
  let result: Record<string, string> = {}
  try {
    result = (await CapacitorCookies.getCookies({ url: apiUrl(baseUrl, '/') })) || {}
  } catch (err) {
    console.warn('cookie read failed', err)
    return ''
  }
  const parts = Object.entries(result)
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([name, value]) => `${name}=${value as string}`)
  return parts.join('; ')
}

/** True once the WebView has navigated off the login page to the gateway itself. */
export function isPastLogin(baseUrl: string, candidate: string | undefined): boolean {
  if (!candidate) return false
  try {
    const target = new URL(candidate)
    const base = new URL(baseUrl)
    if (target.origin !== base.origin) return false
    const loginPath = `${base.pathname.replace(/\/+$/, '')}/login`
    if (target.pathname === loginPath) return false
    if (target.pathname.startsWith('/auth/')) return false
    return true
  } catch {
    return false
  }
}

/**
 * Open the gateway's login page, wait for the user to finish, then harvest the
 * session cookie and prove it works by minting one ticket.
 */
export async function signInWithWebView(
  baseUrl: string,
  onProgress?: (phase: 'opening' | 'waiting' | 'verifying') => void,
): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    throw new AuthError('Browser sign-in runs in the app, not a desktop browser')
  }
  onProgress?.('opening')

  let navigatedAway = false
  const listeners = [] as Array<{ remove: () => Promise<void> }>
  let settle: (reason: 'navigated' | 'closed') => void = () => {}
  const finished = new Promise<'navigated' | 'closed'>((resolve) => {
    settle = resolve
  })

  listeners.push(
    await InAppBrowser.addListener('browserPageNavigationCompleted', ({ url }) => {
      if (isPastLogin(baseUrl, url)) {
        navigatedAway = true
        settle('navigated')
      }
    }),
  )
  listeners.push(
    await InAppBrowser.addListener('browserClosed', () => settle('closed')),
  )

  try {
    await InAppBrowser.openInWebView({
      url: apiUrl(baseUrl, '/login'),
      options: {
        ...DefaultWebViewOptions,
        showURL: true,
        showToolbar: true,
        clearCache: false,
        clearSessionCache: false,
        android: {
          ...DefaultWebViewOptions.android,
          // Share the cookie jar with the app — without this the sign-in cannot
          // be read back, and the whole mode is impossible.
          isIsolated: false,
        },
      },
    })
    onProgress?.('waiting')

    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5 * 60_000))
    const outcome = await Promise.race([finished, timeout])
    if (outcome === 'timeout') throw new AuthError('Sign-in timed out')
    if (outcome === 'closed' && !navigatedAway) {
      throw new AuthError('Sign-in was closed before it completed')
    }

    onProgress?.('verifying')
    // The WebView flushes its cookie store a beat after the page load settles, so
    // give the jar a moment before declaring failure.
    let cookie = ''
    for (let attempt = 0; attempt < 4 && !cookie; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400))
      cookie = await readGatewayCookies(baseUrl)
    }
    if (!cookie) {
      throw new AuthError(
        'Signed in, but the app could not read the session cookie. Switch this connection to “Username & password”.',
      )
    }
    // Prove the cookie is a real session before reporting success.
    await mintTicket(baseUrl, cookie)
    return cookie
  } finally {
    for (const listener of listeners) {
      try {
        await listener.remove()
      } catch {
        /* ignore */
      }
    }
    try {
      await InAppBrowser.close()
    } catch {
      /* already closed */
    }
  }
}
