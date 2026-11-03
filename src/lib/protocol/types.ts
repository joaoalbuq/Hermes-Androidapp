/**
 * Wire types for the Hermes TUI/Desktop gateway JSON-RPC protocol.
 *
 * Source of truth: tui_gateway/server.py, tui_gateway/ws.py,
 * apps/shared/src/gateway-contract.openrpc.json (generated from tui_gateway/contracts).
 *
 * Framing over /api/ws is newline-free JSON-RPC text frames:
 *   client -> server request : {jsonrpc:'2.0', id:number, method:string, params:object}
 *   server -> client response: {jsonrpc:'2.0', id:number, result|error}
 *   server -> client event   : {jsonrpc:'2.0', method:'event', params:{type, session_id?, payload?}}
 *   server -> client request : {jsonrpc:'2.0', id:string, method:string, params}   <-- we must answer
 */

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export interface RpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: number | string
  result?: T
  error?: RpcError
}

export interface EventFrame {
  jsonrpc: '2.0'
  method: 'event'
  params: {
    type: string
    session_id?: string
    payload?: Record<string, unknown> | null
  }
}

export interface ServerRequestFrame {
  jsonrpc: '2.0'
  /** String id, e.g. "srq-7" — answers must echo it verbatim. */
  id: string
  method: string
  params: Record<string, unknown>
}

export type InboundFrame = RpcResponse | EventFrame | ServerRequestFrame

/**
 * The query credential a WebSocket dial presents.
 *
 * `token` is the dashboard session token (loopback / --insecure gateways).
 * `ticket` is the one-use ticket a gated gateway mints for an authenticated
 * session — see lib/protocol/auth.ts.
 */
export interface Credential {
  kind: 'token' | 'ticket'
  value: string
}

/** A row from session.list. */
export interface SessionListRow {
  id: string
  resolved_id?: string | null
  title?: string
  preview?: string
  started_at?: number
  message_count?: number
  source?: string
}

/** A row from session.active_list — sessions live in the gateway process right now. */
export interface SessionActiveItem {
  current: boolean
  id: string
  session_key: string
  last_active: number
  message_count: number
  model: string
  preview: string
  title: string
  source?: string | null
  started_at: number
  /** "working" | "waiting" | "starting" | "idle" */
  status: string
}

/** One projected transcript row. Tool rows carry name/args/content instead of text. */
export interface TranscriptMessage {
  role: string
  text?: string | null
  content?: unknown
  tool_call_id?: string | null
  timestamp?: number | null
  row_id?: number | null
  display_kind?: string | null
  display_metadata?: Record<string, unknown> | null
  name?: string | null
  context?: string | null
  args?: Record<string, unknown> | null
  reasoning?: string | null
  [key: string]: unknown
}

/** session_auto_continue._inflight_snapshot — the turn history does not hold yet. */
export interface InflightTurn {
  assistant?: string
  streaming?: boolean
  user?: string
  display_kind?: string | null
  display_metadata?: Record<string, unknown> | null
  corrections?: string[] | null
  correction_offsets?: number[] | null
  error?: string | null
  status?: string | null
  recoverable?: boolean | null
  error_surface?: Record<string, unknown> | null
}

/** server_requests.Request.snapshot — a question still awaiting an answer. */
export interface OpenRequestEntry {
  id: string
  method: string
  params: Record<string, unknown>
}

export interface SessionLiveInfo {
  model?: string
  provider?: string
  cwd?: string
  title?: string
  running?: boolean
  turn_started_at?: number | null
  stored_session_id?: string
  approval_mode?: string
  /** The effort the user asked for, e.g. "high" (agent/reasoning_effort.py ladder). */
  reasoning_effort?: string
  /** The level this provider route actually sends after its clamp. */
  reasoning_effort_wire?: string
  [key: string]: unknown
}

/**
 * One provider row from `model.options` — the gateway's picker inventory.
 *
 * `models` are the ids the picker may submit; `capabilities` is keyed by model id
 * and says whether that model reasons at all (`reasoning`) and whether reasoning
 * can be switched off (`can_disable_reasoning`).
 */
export interface ModelOptionProvider {
  slug: string
  name?: string
  models?: string[]
  total_models?: number
  is_current?: boolean
  is_user_defined?: boolean
  source?: string
  authenticated?: boolean
  warning?: string | null
  unavailable_models?: string[] | null
  capabilities?: Record<string, ModelCapabilities>
  [key: string]: unknown
}

export interface ModelCapabilities {
  reasoning?: boolean
  can_disable_reasoning?: boolean | null
  fast?: boolean
  ultrafast?: boolean
  [key: string]: unknown
}

export interface ModelOptionsResult {
  providers?: ModelOptionProvider[]
  model?: string
  provider?: string
}

/** command.dispatch's structured directive (tui_gateway/contracts/tools_commands.py). */
export interface CommandDispatchResult {
  type?: 'exec' | 'alias' | 'plugin' | 'send' | 'skill' | 'prefill'
  output?: string | null
  target?: string | null
  message?: string | null
  notice?: string | null
  display?: string | null
  name?: string | null
  status?: string | null
}

/** Result of session.activate / session.resume / session.create. */
export interface SessionAttachResult {
  session_id: string
  stored_session_id?: string | null
  resumed?: string | null
  session_key?: string | null
  message_count: number
  messages: TranscriptMessage[]
  info: SessionLiveInfo
  running?: boolean | null
  status?: string | null
  turn_started_at?: number | null
  started_at?: number | null
  inflight?: InflightTurn | null
  open_requests?: OpenRequestEntry[] | null
  pending_approval?: Record<string, unknown> | null
  queued?: Record<string, unknown> | null
  messages_omitted?: boolean | null
  hydrating?: boolean | null
}

/**
 * A chat carried inside a profiles.list row.
 *
 * The key is `id` (the durable/stored id — the one session.resume accepts), not
 * `session_id`. Reading `session_id` here yields undefined, which silently sent
 * the roster's "open last chat" down the wrong branch.
 */
export interface ProfileSessionRef {
  id: string
  title?: string
  preview?: string
  started_at?: number
  last_active?: number
  message_count?: number
  /** canonical_session only: the resolved lineage behind the forever chat. */
  resolved_id?: string
  root_title?: string
}

export interface ProfileRow {
  name: string
  path: string
  is_default?: boolean
  model?: string | null
  provider?: string | null
  description?: string
  display_name?: string
  skill_count?: number
  last_session?: ProfileSessionRef | null
  /** The profile's forever chat, titled "Bot Chat". */
  canonical_session?: ProfileSessionRef | null
  worker_session?: ProfileSessionRef | null
}

export interface ClarifyQuestion {
  qid: string
  question: string
  choices?: string[] | null
  multi_select?: boolean
}

/** approval choices, per ApprovalChoice enum. */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

/** Methods this client answers. Everything else is refused with -32601 (see client.ts). */
export const HANDLED_SERVER_REQUESTS = [
  'approval',
  'clarify',
  'sudo',
  'secret',
  'vault.code',
  'vault.unlock_prompt',
] as const

export const METHOD_NOT_FOUND = -32601
