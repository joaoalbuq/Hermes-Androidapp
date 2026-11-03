import { buildWsUrl } from './url'
import {
  METHOD_NOT_FOUND,
  type Credential,
  type EventFrame,
  type InboundFrame,
  type RpcError,
  type RpcResponse,
  type ServerRequestFrame,
} from './types'

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'signing_in'
  | 'handshaking'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'auth_failed'

export interface ClientHandlers {
  onState?: (state: ConnectionState, detail?: string) => void
  onEvent?: (type: string, sessionId: string | null, payload: Record<string, unknown>) => void
  onReady?: (payload: Record<string, unknown>) => void
  /**
   * Return a JSON-RPC *result* to answer a server request, or `null` to let the
   * client refuse it with -32601 so the agent fails fast instead of timing out.
   */
  onServerRequest?: (
    method: string,
    params: Record<string, unknown>,
    /** JSON-RPC request id to echo when answering; also the key for request.cancel. */
    id: string,
  ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null
  /** Fired when the socket closes; `code` is the WS close code (4401/4403 are gateway refusals). */
  onClosed?: (code: number, reason: string) => void
}

export interface ClientOptions {
  baseUrl: string
  /** Static session token (loopback / --insecure gateways). */
  token?: string
  /**
   * Resolve the query credential before every dial, reconnects included.
   * A gated gateway's ticket lives 30 s and is single-use, so it must never be
   * cached across dials. Takes precedence over `token`.
   */
  credential?: () => Promise<Credential>
  handlers: ClientHandlers
}

/** WS close codes the gateway uses for sidecar refusals (see web_server_chat.py). */
export const CLOSE_CODES: Record<number, string> = {
  4400: 'bad request',
  4401: 'bad credential — token rejected',
  4403: 'not allowed — chat disabled, or host/origin mismatch',
  4404: 'chat disabled',
  4408: 'peer not allowed',
}

/** Pre-accept refusals arrive as an abnormal close with no code of their own. */
export const ABNORMAL_CLOSE = 1006

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const HEARTBEAT_MS = 15_000
const READY_TIMEOUT_MS = 10_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RpcCallError extends Error {
  code: number
  data: unknown

  constructor(error: RpcError) {
    super(error.message || `gateway error ${error.code}`)
    this.name = 'RpcCallError'
    this.code = error.code
    this.data = error.data
  }
}

/**
 * One socket to one (connection, profile-selectable) gateway.
 *
 * Lifecycle mirrors what the Desktop app does:
 *   dial -> wait for the `gateway.ready` event -> client.capabilities{server_requests:true}
 *        -> discovery -> attach.
 *
 * The capabilities call is mandatory. A WebSocket client that never advertises
 * server_requests is treated as a pre-approvals build and every approval /
 * clarify / sudo request for it is failed immediately by the gateway
 * (tui_gateway/server_requests.py), which looks from the phone like "the agent
 * silently ignores my answers".
 */
export class GatewayClient {
  readonly baseUrl: string
  readonly token: string
  private readonly handlers: ClientHandlers
  private readonly credential?: () => Promise<Credential>
  private dialling = false

  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private advertised = false
  private ready = false
  private manualClose = false
  private attempt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  state: ConnectionState = 'idle'
  /** Server request methods this backend says it may send (from client.capabilities). */
  serverRequestMethods: string[] = []
  /** gateway.capabilities result, when the build advertises one. */
  gatewayCapabilities: Record<string, unknown> | null = null

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl
    this.token = options.token || ''
    this.credential = options.credential
    this.handlers = options.handlers
  }

  private setState(state: ConnectionState, detail?: string) {
    this.state = state
    this.handlers.onState?.(state, detail)
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    if (this.dialling) return
    this.manualClose = false
    this.ready = false
    this.advertised = false
    void this.dial()
  }

  /** Sign in (if needed), then dial. */
  private async dial() {
    this.dialling = true
    let credential: Credential = { kind: 'token', value: this.token }
    try {
      if (this.credential) {
        this.setState('signing_in')
        credential = await this.credential()
      }
    } catch (err) {
      // A refused sign-in is not a transient network fault: retrying would hammer
      // the gateway with credentials. Surface it and let the user fix Settings.
      this.dialling = false
      this.setState('auth_failed', (err as Error).message || 'sign-in failed')
      return
    }
    this.dialling = false
    if (this.manualClose) return
    this.openSocket(credential)
  }

  private openSocket(credential: Credential) {
    this.setState(this.attempt > 0 ? 'reconnecting' : 'connecting')

    let url: string
    try {
      url = buildWsUrl(this.baseUrl, credential)
    } catch (err) {
      this.setState('closed', (err as Error).message)
      return
    }

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      this.setState('closed', (err as Error).message)
      this.scheduleReconnect()
      return
    }
    this.ws = socket

    socket.onopen = () => {
      this.attempt = 0
      this.setState('handshaking')
      // Safety net: a gateway that never sends gateway.ready (or an older build)
      // still gets capabilities, so approvals are never silently withdrawn.
      this.readyTimer = setTimeout(() => {
        if (!this.ready) {
          this.ready = true
          void this.advertise()
        }
      }, READY_TIMEOUT_MS)
      this.startHeartbeat()
    }

    socket.onmessage = (event: MessageEvent<string>) => {
      this.handleFrame(event.data)
    }

    socket.onerror = () => {
      // The browser gives no detail here; onclose carries the code.
    }

    socket.onclose = (event: CloseEvent) => {
      this.stopHeartbeat()
      if (this.readyTimer) {
        clearTimeout(this.readyTimer)
        this.readyTimer = null
      }
      this.rejectAll(new Error(`connection closed (${event.code})`))
      this.ws = null
      const detail =
        CLOSE_CODES[event.code] ||
        (event.reason || '').trim() ||
        (event.code === ABNORMAL_CLOSE
          ? 'gateway refused the WebSocket upgrade (401/403 before accept — check the credential)'
          : '')
      this.handlers.onClosed?.(event.code, detail || 'closed')

      if (this.manualClose) {
        this.setState('closed', detail)
        return
      }
      if (event.code === 4401) {
        this.setState('auth_failed', detail || 'token rejected')
        return
      }
      this.setState('reconnecting', detail)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.manualClose) return
    if (this.reconnectTimer) return
    this.attempt += 1
    const delay = Math.min(15_000, 800 * Math.pow(1.6, Math.min(this.attempt - 1, 6)))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  close() {
    this.manualClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    this.rejectAll(new Error('client closed'))
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.setState('closed')
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.request('ping', {}, 8_000).catch(() => {
        // A dead socket surfaces on onclose; ignore transient ping failures.
      })
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private handleFrame(raw: string) {
    let frame: InboundFrame
    try {
      frame = JSON.parse(raw) as InboundFrame
    } catch {
      return
    }

    // server -> client event
    if ('method' in frame && frame.method === 'event' && 'params' in frame && frame.params) {
      const params = (frame as EventFrame).params
      const payload = (params.payload || {}) as Record<string, unknown>
      if (params.type === 'gateway.ready') {
        this.ready = true
        if (this.readyTimer) {
          clearTimeout(this.readyTimer)
          this.readyTimer = null
        }
        this.setState('open')
        void this.advertise()
        this.handlers.onReady?.(payload)
        return
      }
      this.handlers.onEvent?.(params.type, params.session_id || null, payload)
      return
    }

    // server -> client request (string id + method) that we must answer
    if ('method' in frame && 'id' in frame) {
      void this.handleServerRequest(frame as ServerRequestFrame)
      return
    }

    // response to one of our requests
    if ('id' in frame) {
      const response = frame as RpcResponse
      const id = typeof response.id === 'number' ? response.id : Number(response.id)
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (response.error) pending.reject(new RpcCallError(response.error))
      else pending.resolve(response.result)
    }
  }

  private async advertise() {
    if (this.advertised) return
    this.advertised = true
    try {
      const result = (await this.request('client.capabilities', {
        server_requests: true,
        desktop_local: false,
      })) as { server_requests?: string[] } | null
      this.serverRequestMethods = result?.server_requests || []
    } catch (err) {
      // Older gateway: the method may not exist. Nothing else to do — the socket
      // still streams; approvals will be refused server-side, which is the
      // documented behaviour of a client that cannot advertise.
      console.warn('client.capabilities failed', err)
    }
    try {
      this.gatewayCapabilities = (await this.request('gateway.capabilities', {}, 10_000)) as Record<
        string,
        unknown
      >
    } catch {
      this.gatewayCapabilities = null
    }
  }

  private async handleServerRequest(frame: ServerRequestFrame) {
    const handler = this.handlers.onServerRequest
    let result: Record<string, unknown> | null = null
    if (handler) {
      try {
        result = await handler(frame.method, frame.params || {}, frame.id)
      } catch (err) {
        console.warn('server request handler threw', frame.method, err)
        result = null
      }
    }
    if (result === null) {
      // Fail fast on purpose: the agent must not wait out a timeout for a method
      // this host does not implement.
      this.send({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: METHOD_NOT_FOUND, message: `method not supported by this client: ${frame.method}` },
      })
      return
    }
    this.send({ jsonrpc: '2.0', id: frame.id, result })
  }

  private send(frame: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }

  /** How many requests are in flight (used by the UI to show a spinner). */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Answer a server->client request by id, without a waiting handler.
   *
   * Needed for `open_requests`: session.activate/session.resume replay requests
   * that were raised before this client connected, so no handler promise exists
   * for them — but they are still answerable, and the agent is still waiting.
   */
  respond(id: string, result: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  /** Refuse a replayed request the way an unimplemented method is refused. */
  refuse(id: string, method: string): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code: METHOD_NOT_FOUND, message: `method not supported by this client: ${method}` },
    })
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
      if (!this.advertised && method !== 'ping' && this.ready) void this.advertise()
    })
  }

  private rejectAll(err: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }
}
