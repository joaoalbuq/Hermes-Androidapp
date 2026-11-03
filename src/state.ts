import type {
  InflightTurn,
  OpenRequestEntry,
  SessionAttachResult,
  SessionLiveInfo,
  SessionListRow,
  SessionActiveItem,
  TranscriptMessage,
} from './lib/protocol/types'

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; error?: string | null }
  | {
      kind: 'tool'
      id: string
      toolId: string
      name: string
      detail: string
      status: 'running' | 'done'
      durationS?: number | null
      resultText?: string | null
    }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'error' }

export interface SessionState {
  id: string
  title: string
  preview: string
  running: boolean
  /** "working" | "waiting" | "starting" | "idle" */
  status: string
  model: string
  profile: string | null
  attached: boolean
  items: ChatItem[]
  streamText: string
  streaming: boolean
  prompts: OpenRequestEntry[]
  info: SessionLiveInfo | null
  messageCount: number
  lastActive: number
  unread: number
  /** true when the turn came from the gateway (background job), not a typed prompt */
  inflightDisplayKind?: string | null
  inflightDisplayText?: string | null
}

export interface Store {
  sessions: Record<string, SessionState>
  /** Sidebar order, newest activity first. */
  order: string[]
  activeId: string | null
  /** Discovery payloads, kept for the roster view. */
  stored: SessionListRow[]
  live: SessionActiveItem[]
  loadingList: boolean
}

export const initialStore: Store = {
  sessions: {},
  order: [],
  activeId: null,
  stored: [],
  live: [],
  loadingList: false,
}

let seq = 0
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) return textOf((part as { text: unknown }).text)
        return ''
      })
      .join('')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** One projected transcript row -> one renderable item. */
export function itemFromTranscript(row: TranscriptMessage): ChatItem | null {
  if (row.display_kind === 'hidden') return null
  if (row.role === 'user') {
    const text = row.text ?? textOf(row.content)
    if (!text) return null
    return { kind: 'user', id: `t-${row.row_id ?? uid('r')}`, text }
  }
  if (row.role === 'assistant') {
    const text = row.text ?? textOf(row.content)
    if (!text) return null
    return { kind: 'assistant', id: `t-${row.row_id ?? uid('r')}`, text, streaming: false }
  }
  if (row.role === 'tool') {
    const args = row.args ? JSON.stringify(row.args) : ''
    const detail = row.context || row.text || (args.length > 120 ? `${args.slice(0, 120)}…` : args)
    return {
      kind: 'tool',
      id: `t-${row.row_id ?? uid('r')}`,
      toolId: row.tool_call_id || uid('tool'),
      name: row.name || 'tool',
      detail: detail || '',
      status: 'done',
      resultText: typeof row.content === 'string' ? row.content : row.content ? textOf(row.content) : null,
    }
  }
  if (row.role === 'system' || row.role === 'developer') {
    const text = row.text ?? textOf(row.content)
    return text ? { kind: 'system', id: uid('sys'), text, tone: 'info' } : null
  }
  return null
}

function emptySession(id: string, patch: Partial<SessionState> = {}): SessionState {
  return {
    id,
    title: '',
    preview: '',
    running: false,
    status: 'idle',
    model: '',
    profile: null,
    attached: false,
    items: [],
    streamText: '',
    streaming: false,
    prompts: [],
    info: null,
    messageCount: 0,
    lastActive: Date.now(),
    unread: 0,
    ...patch,
  }
}

function touch(store: Store, id: string): string[] {
  const rest = store.order.filter((x) => x !== id)
  return [id, ...rest]
}

function withSession(store: Store, id: string, patch: Partial<SessionState>): Store {
  const existing = store.sessions[id] ?? emptySession(id)
  return {
    ...store,
    sessions: { ...store.sessions, [id]: { ...existing, ...patch } },
    order: store.order.includes(id) ? store.order : [id, ...store.order],
  }
}

/** Rebuild the in-progress turn from session.activate's `inflight`, exactly as it will land in history. */
function inflightItems(inflight: InflightTurn): { items: ChatItem[]; streamText: string } {
  const items: ChatItem[] = []
  if (inflight.user) items.push({ kind: 'user', id: uid('u'), text: inflight.user })
  const corrections = inflight.corrections || []
  for (const correction of corrections) {
    items.push({ kind: 'system', id: uid('c'), text: `Steered mid-turn: ${correction}`, tone: 'info' })
  }
  const streamText = inflight.assistant || ''
  // A turn still streaming is rendered as the live bubble (streamText), because
  // further message.delta events append to it. Only a retained, finished turn is
  // materialised as a normal item, so its text is never shown twice.
  if (streamText && !inflight.streaming) {
    items.push({ kind: 'assistant', id: uid('a'), text: streamText, streaming: false })
  }
  if (inflight.error) {
    items.push({ kind: 'system', id: uid('e'), text: inflight.error, tone: 'error' })
  }
  return { items, streamText }
}

export type Action =
  | { type: 'discovery'; stored: SessionListRow[]; live: SessionActiveItem[] }
  | { type: 'listLoading'; value: boolean }
  | { type: 'attach'; sessionId: string; result: SessionAttachResult; profile?: string | null }
  | { type: 'detach'; sessionId: string }
  | { type: 'active'; sessionId: string | null }
  | { type: 'localUser'; sessionId: string; text: string }
  | { type: 'optimisticAssistant'; sessionId: string; text: string }
  | { type: 'clearPrompts'; sessionId?: string }
  | {
      type: 'prompt'
      sessionId: string | null
      request: { id: string; method: string; params: Record<string, unknown> }
    }
  | { type: 'promptResolved'; id: string }
  | { type: 'event'; sessionId: string | null; eventType: string; payload: Record<string, unknown> }
  | { type: 'reset' }

export function reducer(store: Store, action: Action): Store {
  switch (action.type) {
    case 'reset':
      return initialStore

    case 'listLoading':
      return { ...store, loadingList: action.value }

    case 'discovery': {
      const sessions = { ...store.sessions }
      const order = [...store.order]
      // Rows from the live feed carry liveness; stored rows carry the transcript size.
      const merge = (id: string, patch: Partial<SessionState>) => {
        sessions[id] = { ...(sessions[id] ?? emptySession(id)), ...patch }
        if (!order.includes(id)) order.push(id)
      }
      for (const row of action.live) {
        merge(row.id, {
          title: row.title || sessions[row.id]?.title || '',
          preview: row.preview || sessions[row.id]?.preview || '',
          running: row.status === 'working' || row.status === 'starting',
          status: row.status,
          model: row.model || '',
          messageCount: row.message_count,
          lastActive: row.last_active * 1000,
        })
      }
      for (const row of action.stored) {
        const existing = sessions[row.id]
        merge(row.id, {
          title: row.title || existing?.title || '',
          preview: row.preview || existing?.preview || '',
          messageCount: row.message_count ?? existing?.messageCount ?? 0,
          lastActive: existing?.lastActive ?? (row.started_at ? row.started_at * 1000 : Date.now()),
        })
      }
      return { ...store, sessions, order: order.filter((id) => sessions[id]) , stored: action.stored, live: action.live }
    }

    case 'attach': {
      const { sessionId, result } = action
      const items = (result.messages || [])
        .map(itemFromTranscript)
        .filter((item): item is ChatItem => item !== null)
      let streamText = ''
      let prompts = result.open_requests || []
      if (result.inflight) {
        const rebuilt = inflightItems(result.inflight)
        items.push(...rebuilt.items)
        streamText = rebuilt.streamText
      }
      const info = result.info || null
      return withSession(store, sessionId, {
        title: info?.title || store.sessions[sessionId]?.title || '',
        model: info?.model || store.sessions[sessionId]?.model || '',
        profile: action.profile ?? store.sessions[sessionId]?.profile ?? null,
        items,
        streamText,
        streaming: !!(result.inflight?.streaming || result.running),
        running: !!(result.running || result.inflight?.streaming),
        status: result.status || result.inflight?.status || (result.running ? 'working' : 'idle'),
        prompts,
        info,
        messageCount: result.message_count ?? items.length,
        attached: true,
        unread: 0,
        inflightDisplayKind: result.inflight?.display_kind ?? null,
        inflightDisplayText:
          (result.inflight?.display_metadata?.display_text as string | undefined) ??
          (result.inflight?.display_metadata?.title_preview as string | undefined) ??
          null,
      })
    }

    case 'detach': {
      const session = store.sessions[action.sessionId]
      if (!session) return store
      return {
        ...store,
        sessions: { ...store.sessions, [action.sessionId]: { ...session, attached: false } },
      }
    }

    case 'active': {
      if (!action.sessionId) return { ...store, activeId: null }
      const next = withSession(store, action.sessionId, { unread: 0 })
      return { ...next, activeId: action.sessionId, order: touch(next, action.sessionId) }
    }

    case 'localUser': {
      const session = store.sessions[action.sessionId] ?? emptySession(action.sessionId)
      return withSession(store, action.sessionId, {
        items: [...session.items, { kind: 'user', id: uid('u'), text: action.text }],
        streaming: true,
        running: true,
        status: 'working',
      })
    }

    case 'optimisticAssistant':
      return withSession(store, action.sessionId, { streamText: action.text, streaming: true })

    case 'clearPrompts': {
      if (!action.sessionId) return store
      return withSession(store, action.sessionId, { prompts: [] })
    }

    case 'prompt': {
      const sessionId = action.sessionId
      if (!sessionId) return store
      const session = store.sessions[sessionId] ?? emptySession(sessionId)
      if (session.prompts.some((p) => p.id === action.request.id)) return store
      return withSession(store, sessionId, { prompts: [...session.prompts, action.request] })
    }

    case 'promptResolved': {
      const sessions = { ...store.sessions }
      let changed = false
      for (const [id, session] of Object.entries(sessions)) {
        if (!session.prompts.some((p) => p.id === action.id)) continue
        sessions[id] = { ...session, prompts: session.prompts.filter((p) => p.id !== action.id) }
        changed = true
      }
      return changed ? { ...store, sessions } : store
    }

    case 'event': {
      const { eventType, payload } = action
      const sessionId = action.sessionId
      if (!sessionId) return store
      const session = store.sessions[sessionId] ?? emptySession(sessionId)
      const isActive = store.activeId === sessionId

      switch (eventType) {
        case 'message.start': {
          const header =
            (payload.display_text as string | undefined) ||
            (payload.text as string | undefined) ||
            null
          return withSession(store, sessionId, {
            streaming: true,
            running: true,
            status: 'working',
            streamText: '',
            items: header
              ? [...session.items, { kind: 'system', id: uid('h'), text: header, tone: 'info' }]
              : session.items,
          })
        }
        case 'message.delta': {
          // `text: null` is a segment boundary, not content.
          const delta = typeof payload.text === 'string' ? payload.text : ''
          if (!delta) return store
          return withSession(store, sessionId, {
            streamText: session.streamText + delta,
            streaming: true,
            running: true,
            status: 'working',
          })
        }
        case 'message.complete': {
          const text = typeof payload.text === 'string' && payload.text ? payload.text : session.streamText
          const status = typeof payload.status === 'string' ? payload.status : null
          const items = [...session.items]
          if (text) items.push({ kind: 'assistant', id: uid('a'), text, streaming: false })
          if (payload.warning) {
            items.push({ kind: 'system', id: uid('w'), text: String(payload.warning), tone: 'info' })
          }
          return withSession(store, sessionId, {
            items,
            streamText: '',
            streaming: false,
            running: false,
            status: status === 'cancelled' || status === 'interrupted' ? 'idle' : 'idle',
            unread: isActive ? 0 : session.unread + 1,
            preview: text ? text.slice(0, 140) : session.preview,
          })
        }
        case 'tool.start': {
          const toolId = String(payload.tool_id || uid('tool'))
          const name = String(payload.name || 'tool')
          const detail =
            (payload.preview as string | undefined) ||
            (payload.args_text as string | undefined) ||
            (payload.context as string | undefined) ||
            (payload.args ? JSON.stringify(payload.args).slice(0, 200) : '')
          return withSession(store, sessionId, {
            running: true,
            status: 'working',
            items: [
              ...session.items,
              { kind: 'tool', id: uid('tool'), toolId, name, detail, status: 'running' },
            ],
          })
        }
        case 'tool.complete': {
          const toolId = String(payload.tool_id || '')
          const items = session.items.map((item) =>
            item.kind === 'tool' && item.toolId === toolId
              ? {
                  ...item,
                  status: 'done' as const,
                  durationS: typeof payload.duration_s === 'number' ? payload.duration_s : null,
                  resultText:
                    (payload.summary as string | undefined) ||
                    (payload.result_text as string | undefined) ||
                    item.resultText ||
                    null,
                }
              : item,
          )
          return withSession(store, sessionId, { items })
        }
        case 'session.title': {
          const title = String(payload.title || session.title)
          return withSession(store, sessionId, { title })
        }
        case 'session.info': {
          const info = payload as unknown as SessionLiveInfo
          return withSession(store, sessionId, {
            info,
            model: info.model || session.model,
            title: info.title || session.title,
            running: !!info.running,
          })
        }
        case 'error': {
          const message = String(payload.message || 'gateway error')
          return withSession(store, sessionId, {
            streaming: false,
            running: false,
            items: [...session.items, { kind: 'system', id: uid('e'), text: message, tone: 'error' }],
          })
        }
        default:
          return store
      }
    }

    default:
      return store
  }
}
