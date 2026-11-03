import { GatewayClient } from './protocol/client'
import { buildStatusUrl, normalizeBaseUrl } from './protocol/url'
import {
  PasswordAuthSession,
  CookieAuthSession,
  DEFAULT_PROVIDER,
  type AuthMode,
} from './protocol/auth'
import type { Credential } from './protocol/types'

export interface LegResult {
  ok: boolean
  detail: string
  status?: number
}

export interface TestResult {
  http: LegResult
  ws: LegResult
  /** True only when both legs work. */
  ok: boolean
}

export interface TestTarget {
  baseUrl: string
  authMode?: AuthMode
  token?: string
  username?: string
  password?: string
  provider?: string
  /** Session cookie harvested from a browser sign-in. */
  cookie?: string
}

/**
 * Probe both legs of a gateway connection separately.
 *
 * They fail independently and that distinction is the whole point: HTTP passing
 * while the WebSocket fails usually means a proxy, firewall, or the gateway's
 * auth/Origin guard is closing /api/ws (4401 = bad credential, 4403 = host/origin
 * or chat-disabled).
 */
export async function testBothLegs(target: TestTarget): Promise<TestResult> {
  let origin = ''
  try {
    origin = normalizeBaseUrl(target.baseUrl)
  } catch (err) {
    const failed: LegResult = { ok: false, detail: (err as Error).message }
    return { http: failed, ws: failed, ok: false }
  }

  const mode: AuthMode = target.authMode || 'token'
  const passwordAuth = {
    username: target.username || '',
    password: target.password || '',
    provider: target.provider || DEFAULT_PROVIDER,
  }

  if (mode === 'password' && !passwordAuth.password) {
    const detail = 'No password saved for this connection'
    return { http: { ok: false, detail }, ws: { ok: false, detail }, ok: false }
  }
  if (mode === 'signin' && !target.cookie) {
    const detail = 'Not signed in yet — use “Use” to open the gateway sign-in page'
    return { http: { ok: false, detail }, ws: { ok: false, detail }, ok: false }
  }

  const session =
    mode === 'password'
      ? new PasswordAuthSession(origin, passwordAuth)
      : mode === 'signin'
        ? new CookieAuthSession(origin, target.cookie || '')
        : null
  const credential = session
    ? () => session.credential()
    : async (): Promise<Credential> => ({ kind: 'token', value: target.token || '' })

  const http = session ? await testSignedInHttp(session) : await testHttpLeg(origin, target.token || '')
  const ws = await testWsLeg(origin, credential, mode)
  return { http, ws, ok: http.ok && ws.ok }
}

/** Gated gateway: the status leg uses the same sign-in the socket will use. */
async function testSignedInHttp(session: PasswordAuthSession | CookieAuthSession): Promise<LegResult> {
  try {
    const result = await session.status()
    if (result.status === 200) return { ok: true, detail: 'signed in, gateway reachable', status: 200 }
    if (result.status === 401 || result.status === 403) {
      return { ok: false, detail: `sign-in refused (${result.status})`, status: result.status }
    }
    return { ok: true, detail: `reachable (${result.status})`, status: result.status }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

async function testHttpLeg(baseUrl: string, token: string): Promise<LegResult> {
  const url = buildStatusUrl(baseUrl)
  try {
    const response = await fetch(url, {
      headers: token ? { 'X-Hermes-Session-Token': token } : {},
      cache: 'no-store',
    })
    if (response.ok) return { ok: true, detail: 'HTTP reachable, credentials accepted', status: response.status }
    if (response.status === 401 || response.status === 403) {
      return { ok: true, detail: `HTTP reachable, token rejected (${response.status})`, status: response.status }
    }
    return { ok: true, detail: `HTTP reachable (${response.status})`, status: response.status }
  } catch {
    // Almost always CORS: the gateway only trusts browser origins it knows, and a
    // Capacitor app is not one. An opaque request still proves the host answers.
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store' })
      return { ok: true, detail: 'HTTP reachable (response opaque — CORS blocks reading it)', status: 0 }
    } catch (err) {
      return { ok: false, detail: (err as Error).message || 'HTTP unreachable' }
    }
  }
}

function testWsLeg(
  baseUrl: string,
  credential: () => Promise<Credential>,
  mode: AuthMode,
): Promise<LegResult> {
  return new Promise((resolve) => {
    let settled = false
    let client: GatewayClient | null = null
    const finish = (result: LegResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        client?.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, detail: 'no gateway.ready within 12s' }),
      12_000,
    )

    client = new GatewayClient({
      baseUrl,
      credential,
      handlers: {
        onReady: () => finish({ ok: true, detail: 'WebSocket open, gateway.ready received' }),
        onClosed: (code, detail) =>
          finish({
            ok: false,
            detail: `closed ${code}${detail ? ` — ${detail}` : ''}`,
          }),
        onState: (state, detail) => {
          if (state === 'auth_failed') {
            finish({
              ok: false,
              detail:
                mode === 'password'
                  ? `sign-in failed — ${detail || 'check the username and password'}`
                  : mode === 'signin'
                    ? `session not accepted — ${detail || 'sign in again'}`
                    : detail || 'token rejected',
            })
          }
        },
      },
    })
    client.connect()
  })
}
