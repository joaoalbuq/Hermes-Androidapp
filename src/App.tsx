import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GatewayClient, RpcCallError, type ConnectionState } from './lib/protocol/client'
import { PasswordAuthSession, CookieAuthSession, DEFAULT_PROVIDER } from './lib/protocol/auth'
import { METHOD_NOT_FOUND, type Credential } from './lib/protocol/types'
import {
  HANDLED_SERVER_REQUESTS,
  type OpenRequestEntry,
  type ProfileRow,
  type SessionActiveItem,
  type SessionAttachResult,
  type SessionListRow,
} from './lib/protocol/types'
import {
  MAX_TRANSFER_BYTES,
  fetchGatewayFile,
  fileToBase64,
  type StagedAttachment,
} from './lib/protocol/files'
import { saveBase64File } from './lib/native/downloads'
import { initialStore, reducer } from './state'
import { useReducer } from 'react'
import * as storage from './lib/storage'
import Drawer from './components/Drawer'
import Chat from './components/Chat'
import SettingsScreen from './components/SettingsScreen'
import LoginScreen from './components/LoginScreen'

type Phase = 'loading' | 'setup' | 'main'
type DrawerTab = 'sessions' | 'bots'

/**
 * "There is no session with this id here" — 4007 from session.resume, 4001 from
 * the older canonical handlers. Either way the id is dead and retrying it on
 * another verb is pointless.
 */
const STALE_SESSION_CODES = [4001, 4007]

const isStaleSession = (err: unknown) =>
  err instanceof RpcCallError && STALE_SESSION_CODES.includes(err.code)

const isUnknownMethod = (err: unknown) =>
  err instanceof RpcCallError && err.code === METHOD_NOT_FOUND

export default function App() {
  const [conns, setConns] = useState<storage.SavedConnection[]>([])
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [store, dispatch] = useReducer(reducer, initialStore)
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [profile, setProfile] = useState<string | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('idle')
  const [connDetail, setConnDetail] = useState<string>('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('sessions')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  /** Set when a gated connection needs an in-app sign-in before it can dial. */
  const [loginFor, setLoginFor] = useState<storage.SavedConnection | null>(null)

  const clientRef = useRef<GatewayClient | null>(null)
  const activeConnectionRef = useRef<storage.SavedConnection | null>(null)
  const activeSessionRef = useRef<string | null>(null)
  /** Durable id of the open chat, so a resume does not re-attach what is already open. */
  const durableIdRef = useRef<string | null>(null)
  /** Last attach failure, so a resume chain can report once after trying several ids. */
  const attachErrorRef = useRef<string | null>(null)
  /** Durable id -> runtime handle of the current attach, for events and RPCs. */
  const runtimeByKey = useRef(new Map<string, string>())
  /** The signed-in session, for REST calls that are not JSON-RPC (downloads). */
  const httpAuthRef = useRef<{ httpHeaders: () => Promise<Record<string, string>> } | null>(null)

  /** Fold a runtime handle back onto the durable id the store is keyed by. */
  const durableKeyFor = useCallback((id: string | null): string | null => {
    if (!id) return null
    for (const [key, runtime] of runtimeByKey.current) {
      if (runtime === id) return key
    }
    return id
  }, [])
  const profileRef = useRef<string | null>(null)
  const resolvers = useRef(new Map<string, (result: Record<string, unknown>) => void>())

  useEffect(() => {
    activeSessionRef.current = store.activeId
  }, [store.activeId])
  useEffect(() => {
    profileRef.current = profile
  }, [profile])

  const activeConnection = useMemo(
    () => conns.find((c) => c.id === activeConnectionId) || null,
    [conns, activeConnectionId],
  )

  const activeSession = store.activeId ? store.sessions[store.activeId] : null

  // ------------------------------------------------------------- discovery ---

  const refreshDiscovery = useCallback(async (profileArg?: string | null): Promise<SessionListRow[]> => {
    const client = clientRef.current
    if (!client) return []
    const profile = profileArg === undefined ? profileRef.current : profileArg
    dispatch({ type: 'listLoading', value: true })
    try {
      const params: Record<string, unknown> = { limit: 50 }
      if (profile) params.profile = profile
      const [list, active] = await Promise.all([
        client.request<{ sessions: SessionListRow[] }>('session.list', params),
        client.request<{ sessions: SessionActiveItem[] }>('session.active_list', {
          profile,
        }),
      ])
      dispatch({ type: 'discovery', stored: list?.sessions || [], live: active?.sessions || [] })
      return list?.sessions || []
    } catch (err) {
      setBanner(`Could not list sessions: ${(err as Error).message}`)
      return []
    } finally {
      dispatch({ type: 'listLoading', value: false })
    }
  }, [])

  const refreshProfiles = useCallback(async (): Promise<ProfileRow[]> => {
    const client = clientRef.current
    if (!client) return []
    try {
      // The whole roster, not just the selected bot: the Bots tab lists every
      // profile the gateway knows, each with its most recent chat.
      const result = await client.request<{ profiles: ProfileRow[] }>('profiles.list', {})
      const rows = result?.profiles || []
      setProfiles(rows)
      return rows
    } catch (err) {
      // profiles.list is a long handler and may be unavailable on older builds;
      // the Bots tab then explains itself instead of breaking the app.
      setProfiles([])
      console.warn('profiles.list failed', err)
      return []
    }
  }, [])

  /**
   * Attach to one session and return whether it worked.
   *
   * `sessionId` must be a DURABLE id: the stored id from a list row or a profile
   * roster. Two verbs matter here:
   *   - session.resume  — durable path, reuses a live run or rebuilds a cold one;
   *                       absent on the older in-process sidecar.
   *   - session.activate — only attaches to a session that is already live here.
   * The reply's `session_id` is a RUNTIME handle, minted per attach: it is what
   * prompt.submit and the event stream use, and it is dead the moment this socket
   * closes, so it must never be the id we remember for next launch.
   */
  const attachSession = useCallback(async (sessionId: string, options?: { quiet?: boolean }): Promise<boolean> => {
    const client = clientRef.current
    if (!client) return false
    const profile = profileRef.current
    attachErrorRef.current = null
    const params = {
      session_id: sessionId,
      // The bot this chat belongs to: without it the gateway resolves the
      // session against the default profile home.
      profile,
      cols: null,
    }

    let result: SessionAttachResult | null = null
    let failure: unknown = null
    for (const method of ['session.resume', 'session.activate'] as const) {
      try {
        result = await client.request<SessionAttachResult>(method, {
          ...params,
          ...(method === 'session.resume' ? { defer_history: false, lazy: false } : {}),
        })
        break
      } catch (err) {
        failure = err
        // A dead id fails the same way on the other verb, and a refused profile
        // (4064) will not fix itself: only a missing verb is worth a second try.
        if (isStaleSession(err)) break
      }
    }

    if (!result) {
      const connection = activeConnectionRef.current
      if (isStaleSession(failure)) {
        // Forget the dead id, otherwise every launch repeats this failure.
        if (connection) void storage.saveLastSession(connection.id, profile, null)
        attachErrorRef.current = profile
          ? `bot "${profile}" has no chat with id ${sessionId} any more`
          : `that chat (${sessionId}) no longer exists on the gateway`
      } else {
        attachErrorRef.current = `${(failure as Error)?.message || 'unknown error'}`
      }
      // A resume chain tries several candidates; only the last one may speak.
      if (!options?.quiet) {
        setBanner(
          isStaleSession(failure)
            ? `Could not open ${attachErrorRef.current}. Pick a chat from the list instead.`
            : `Could not attach: ${attachErrorRef.current}`,
        )
      }
      return false
    }

    // Keep the durable id as the chat's identity and hang the runtime handle off
    // it: the drawer, the discovery rows and next launch's resume all speak
    // durable ids, while events and prompt.submit speak the runtime one.
    const durableId = result.stored_session_id || sessionId
    const runtimeId = result.session_id || sessionId
    runtimeByKey.current.set(durableId, runtimeId)
    durableIdRef.current = durableId
    dispatch({ type: 'attach', sessionId: durableId, result, profile, runtimeId })
    dispatch({ type: 'active', sessionId: durableId })
    const connection = activeConnectionRef.current
    if (connection) {
      // Persist the durable id, never the runtime handle.
      void storage.saveLastSession(connection.id, profile, durableId)
    }
    if (result.inflight?.streaming) {
      setBanner('Attached to a turn already running on the gateway.')
    }
    return true
  }, [])

  /**
   * Resume the conversation that was open last.
   *
   * Order: what this phone had open, then the gateway's own per-profile
   * `last_session` (that is the one the Windows app was in — sessions live on the
   * gateway, so attaching by id picks the same conversation and any live turn up
   * mid-stream), then the newest listed session.
   */
  const resumeLastChat = useCallback(
    async (roster: ProfileRow[], stored: SessionListRow[], profileArg?: string | null) => {
      const connection = activeConnectionRef.current
      if (!connection) return
      const profile = profileArg === undefined ? profileRef.current : profileArg

      const saved = await storage.loadLastSession(connection.id, profile)
      const bot = profile
        ? roster.find((row) => row.name === profile)
        : roster.find((row) => row.is_default) || roster[0]
      // The roster's own chats. `last_session` is the newest ordinary chat and
      // `canonical_session` is the bot's forever chat — both carry the durable
      // id under `id`. Try them in turn: a saved id can be stale (chat deleted,
      // or the bot renamed), and one dead id must not block the whole resume.
      const candidates = [
        saved,
        bot?.last_session?.id,
        bot?.canonical_session?.id,
        stored[0]?.id,
      ].filter((id): id is string => !!id)

      for (const target of candidates) {
        if (target === activeSessionRef.current || target === durableIdRef.current) return
        dispatch({ type: 'active', sessionId: target })
        if (await attachSession(target, { quiet: true })) return
      }
      if (candidates.length > 0) {
        setBanner(
          `Could not open a chat${profile ? ` for ${profile}` : ''}: ${attachErrorRef.current || 'no session found'}`,
        )
      } else if (profile) {
        // A bot with an empty roster row is not an error, but leaving the previous
        // bot's chat on screen under a new profile name would be misleading.
        setBanner(`${profile} has no chats yet — start one with ＋.`)
        dispatch({ type: 'active', sessionId: null })
      }
    },
    [attachSession],
  )

  // --------------------------------------------------------------- connect ---

  const connect = useCallback(
    async (connection: storage.SavedConnection) => {
      activeConnectionRef.current = connection
      const [token, password] = await Promise.all([
        storage.loadToken(connection.id),
        storage.loadPassword(connection.id),
      ])
      // A gated gateway (auth_required) rejects a static token outright: the
      // upgrade only takes a one-use ticket minted from a signed-in session.
      // The session is rebuilt on every connect because tickets live 30 s.
      const passwordSession =
        connection.authMode === 'password' && connection.username && password
          ? new PasswordAuthSession(connection.baseUrl, {
              username: connection.username,
              password,
              provider: connection.provider || DEFAULT_PROVIDER,
            })
          : null

      // Browser sign-in: no password in the app at all, just the harvested cookie.
      let cookieSession: CookieAuthSession | null = null
      if (connection.authMode === 'signin') {
        const cookie = await storage.loadCookie(connection.id)
        if (!cookie) {
          setLoginFor(connection)
          setConnState('auth_failed')
          setConnDetail('not signed in')
          clientRef.current?.close()
          clientRef.current = null
          return
        }
        cookieSession = new CookieAuthSession(connection.baseUrl, cookie)
      }

      let credential: (() => Promise<Credential>) | undefined
      if (cookieSession) credential = () => cookieSession.credential()
      else if (passwordSession) credential = () => passwordSession.credential()
      // File downloads are plain REST: they reuse the same session cookie.
      httpAuthRef.current = cookieSession || passwordSession || null

      clientRef.current?.close()
      clientRef.current = null
      dispatch({ type: 'reset' })
      setProfiles([])
      // Come back to the bot that was selected last, so a relaunch continues the
      // same conversation rather than the default one.
      const savedProfile = await storage.loadProfile(connection.id)
      setProfile(savedProfile)
      profileRef.current = savedProfile

      const client = new GatewayClient({
        baseUrl: connection.baseUrl,
        token,
        credential,
        handlers: {
          onState: (state, detail) => {
            setConnState(state)
            if (detail) setConnDetail(detail)
            if (state === 'auth_failed') {
              if (connection.authMode === 'signin') {
                // The saved session is gone or expired: ask for a fresh sign-in
                // instead of retrying a credential that will never work again.
                setLoginFor(connection)
              } else {
                setBanner(detail || 'Sign-in failed — check the connection in Settings.')
              }
            }
          },
          onReady: () => {
            setConnDetail('')
            void (async () => {
              const roster = await refreshProfiles()
              const stored = await refreshDiscovery()
              const active = activeSessionRef.current
              if (active) await attachSession(active)
              else await resumeLastChat(roster, stored)
            })()
          },
          onEvent: (type, eventSessionId, payload) => {
            // Events arrive addressed to the runtime handle; the store is keyed by
            // the durable id so list rows and the open chat are one session.
            const sessionId = durableKeyFor(eventSessionId)
            if (type === 'sessions.changed') {
              void refreshDiscovery()
              return
            }
            if (type === 'request.cancel' || type === 'approval.cancelled') {
              const id =
                (payload.id as string | undefined) ||
                (payload.request_id as string | undefined) ||
                ''
              if (id) {
                dispatch({ type: 'promptResolved', id })
                const resolve = resolvers.current.get(id)
                resolvers.current.delete(id)
                resolve?.({})
              }
              return
            }
            if (type === 'skin.changed' || type === 'platforms.changed' || type === 'cron.changed') return
            dispatch({ type: 'event', sessionId, eventType: type, payload })
          },
          onServerRequest: (method, params, id) => {
            if (!(HANDLED_SERVER_REQUESTS as readonly string[]).includes(method)) return null
            const sessionId =
              durableKeyFor((params.session_id as string | undefined) || null) ||
              activeSessionRef.current
            const request: OpenRequestEntry = { id, method, params }
            dispatch({ type: 'prompt', sessionId, request })
            return new Promise<Record<string, unknown>>((resolve) => {
              resolvers.current.set(id, resolve)
            })
          },
          onClosed: (code, detail) => {
            if (code === 4401) setConnDetail(detail || 'token rejected')
          },
        },
      })
      clientRef.current = client
      client.connect()
    },
    [attachSession, durableKeyFor, refreshDiscovery, refreshProfiles, resumeLastChat],
  )

  // ------------------------------------------------------------------ boot ---

  useEffect(() => {
    void (async () => {
      const [connections, savedActive] = await Promise.all([
        storage.loadConnections(),
        storage.loadActiveConnectionId(),
      ])
      setConns(connections)
      const chosen =
        connections.find((c) => c.id === savedActive)?.id || connections[0]?.id || null
      setActiveConnectionId(chosen)
      if (!chosen) {
        setPhase('setup')
        return
      }
      setPhase('main')
      const connection = connections.find((c) => c.id === chosen)
      if (connection) await connect(connection)
    })()
    return () => {
      clientRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------------------------------------------------- commands ---

  const openSession = useCallback(
    async (sessionId: string) => {
      dispatch({ type: 'active', sessionId })
      setDrawerOpen(false)
      await attachSession(sessionId)
    },
    [attachSession],
  )

  const newChat = useCallback(async () => {
    const client = clientRef.current
    if (!client) return
    setDrawerOpen(false)
    try {
      const result = await client.request<SessionAttachResult>('session.create', {
        profile: profileRef.current,
        source: 'mobile',
      })
      const id = result?.session_id
      if (!id) throw new Error('gateway returned no session id')
      const durableId = result?.stored_session_id || id
      runtimeByKey.current.set(durableId, id)
      durableIdRef.current = durableId
      dispatch({ type: 'attach', sessionId: durableId, result, profile: profileRef.current, runtimeId: id })
      dispatch({ type: 'active', sessionId: durableId })
      const connection = activeConnectionRef.current
      if (connection) {
        void storage.saveLastSession(connection.id, profileRef.current, durableId)
      }
      void refreshDiscovery()
    } catch (err) {
      setBanner(`Could not create a chat: ${(err as Error).message}`)
    }
  }, [refreshDiscovery])

  const sendPrompt = useCallback(
    async (text: string, steer: boolean) => {
      const client = clientRef.current
      const key = activeSessionRef.current
      if (!client || !key) return
      // Address the runtime handle: the durable id is not what prompt.submit takes
      // once a gateway has re-attached the chat under a fresh handle.
      const sessionId = runtimeByKey.current.get(key) || key
      if (steer) {
        // Mid-turn correction: appended to the live run, delivered at the next
        // tool boundary. Never interrupts the turn.
        try {
          await client.request('session.steer', { session_id: sessionId, text })
          return
        } catch (err) {
          setBanner(`Steer rejected, sending as a prompt instead: ${(err as Error).message}`)
        }
      }
      dispatch({ type: 'localUser', sessionId: key, text })
      try {
        await client.request('prompt.submit', { session_id: sessionId, text })
      } catch (err) {
        setBanner(`Send failed: ${(err as Error).message}`)
      }
    },
    [],
  )

  const interrupt = useCallback(async () => {
    const client = clientRef.current
    const key = activeSessionRef.current
    if (!client || !key) return
    const sessionId = runtimeByKey.current.get(key) || key
    try {
      await client.request('session.interrupt', { session_id: sessionId })
    } catch (err) {
      setBanner(`Interrupt failed: ${(err as Error).message}`)
    }
  }, [])

  /**
   * Stage picked files for the next prompt.
   *
   * The legacy wire has no `attachments` field on prompt.submit — it is rejected as
   * an unknown param — so each file is staged by its own RPC first and the prompt
   * then carries the `@file:` reference the gateway hands back. Images are queued
   * in one call (the model sees them next turn); anything else returns a reference.
   */
  const stageFiles = useCallback(async (files: File[]): Promise<StagedAttachment[]> => {
    const client = clientRef.current
    const key = activeSessionRef.current
    if (!client) throw new Error('not connected to the gateway')
    if (!key) throw new Error('open a chat before attaching a file')
    // Staging is addressed at the live chat, so it needs the runtime handle.
    const sessionId = runtimeByKey.current.get(key) || key
    const profile = profileRef.current
    const staged: StagedAttachment[] = []

    for (const file of files) {
      if (file.size > MAX_TRANSFER_BYTES) {
        setBanner(
          `${file.name} is too large to send (${Math.round(file.size / 1024 / 1024)} MB, limit ${Math.round(
            MAX_TRANSFER_BYTES / 1024 / 1024,
          )} MB).`,
        )
        continue
      }
      const mime = file.type || 'application/octet-stream'
      const base64 = await fileToBase64(file)
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      if (mime.startsWith('image/')) {
        try {
          await client.request('image.attach_bytes', {
            session_id: sessionId,
            profile,
            content_base64: base64,
            filename: file.name,
          })
          staged.push({ id, name: file.name, refText: '', kind: 'image', size: file.size })
          continue
        } catch (err) {
          // Builds without the image verb still have file.attach: stage it there.
          if (!isUnknownMethod(err)) {
            setBanner(`Could not attach ${file.name}: ${(err as Error).message}`)
            throw err
          }
        }
      }

      try {
        const result = await client.request<{
          attached?: boolean
          name?: string
          ref_text?: string
          ref_path?: string
        }>('file.attach', {
          session_id: sessionId,
          profile,
          data_url: `data:${mime};base64,${base64}`,
          name: file.name,
        })
        staged.push({
          id,
          name: result?.name || file.name,
          refText: result?.ref_text || (result?.ref_path ? `@file:${result.ref_path}` : ''),
          kind: 'file',
          size: file.size,
        })
      } catch (err) {
        setBanner(
          isUnknownMethod(err)
            ? 'This gateway build has no file.attach, so files cannot be sent from the phone.'
            : `Could not attach ${file.name}: ${(err as Error).message}`,
        )
        throw err
      }
    }
    return staged
  }, [])

  /** Pull a file the agent produced onto the phone. */
  const downloadFile = useCallback(async (path: string) => {
    const connection = activeConnectionRef.current
    if (!connection) return
    const auth = httpAuthRef.current
    const name = path.split(/[/\\]/).pop() || 'file'
    setBanner(`Downloading ${name}…`)
    try {
      const headers = auth ? await auth.httpHeaders() : {}
      const file = await fetchGatewayFile({
        baseUrl: connection.baseUrl,
        path,
        profile: profileRef.current,
        // The durable id: /api/fs/download checks the session belongs to the profile.
        sessionId: activeSessionRef.current,
        headers,
      })
      const saved = await saveBase64File(file.name, file.mime, file.base64)
      setBanner(`Saved ${saved.name} to ${saved.location}.`)
    } catch (err) {
      setBanner(`Download failed: ${(err as Error).message}`)
    }
  }, [])

  const answerPrompt = useCallback((id: string, result: Record<string, unknown>) => {
    const resolve = resolvers.current.get(id)
    resolvers.current.delete(id)
    dispatch({ type: 'promptResolved', id })
    if (resolve) {
      // A live request this client received and is holding open.
      resolve(result)
      return
    }
    // A request replayed through session.activate's open_requests: nobody is
    // waiting on a promise for it, so the response frame has to be sent directly.
    clientRef.current?.respond(id, result)
  }, [])

  const chooseConnection = useCallback(
    async (id: string) => {
      const connection = conns.find((c) => c.id === id)
      if (!connection) return
      setActiveConnectionId(id)
      await storage.saveActiveConnectionId(id)
      setSettingsOpen(false)
      await connect(connection)
    },
    [conns, connect],
  )

  const handleConnectionsChanged = useCallback(
    async (next: storage.SavedConnection[]) => {
      setConns(next)
      await storage.saveConnections(next)
      const chosen = next.find((c) => c.id === activeConnectionId)?.id || next[0]?.id || null
      setActiveConnectionId(chosen)
      await storage.saveActiveConnectionId(chosen)
      if (!chosen) {
        setPhase('setup')
        clientRef.current?.close()
        return
      }
      setPhase('main')
      const connection = next.find((c) => c.id === chosen)
      if (connection) await connect(connection)
    },
    [activeConnectionId, connect],
  )

  // ----------------------------------------------------------------- render ---

  if (phase === 'loading') {
    return (
      <div className="splash">
        <div className="spinner" />
        <p>Loading…</p>
      </div>
    )
  }

  if (loginFor) {
    return (
      <LoginScreen
        connection={loginFor}
        onCancel={() => {
          setLoginFor(null)
          setSettingsOpen(true)
        }}
        onSignedIn={async (cookie) => {
          await storage.saveCookie(loginFor.id, cookie)
          setLoginFor(null)
          setBanner(null)
          await connect(loginFor)
        }}
      />
    )
  }

  if (phase === 'setup' || settingsOpen || !activeConnection) {
    return (
      <SettingsScreen
        connections={conns}
        activeId={activeConnectionId}
        onConnectionsChanged={handleConnectionsChanged}
        onChoose={chooseConnection}
        onClose={conns.length > 0 ? () => setSettingsOpen(false) : undefined}
        connectionState={connState}
        connectionDetail={connDetail}
      />
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-button" onClick={() => setDrawerOpen(true)} aria-label="Open sessions">
          ☰
        </button>
        <div className="topbar-title">
          <strong>{activeSession?.title || 'Hermes'}</strong>
          <span className="topbar-sub">
            {activeConnection.name}
            {profile ? ` · ${profile}` : ''}
            {' · '}
            <span className={`dot ${connState === 'open' ? 'dot-ok' : 'dot-bad'}`} />
            {connState === 'open' ? 'connected' : connState}
          </span>
        </div>
        <button className="icon-button" onClick={newChat} aria-label="New chat">
          ＋
        </button>
      </header>

      {banner ? (
        <div className="banner">
          <span>{banner}</span>
          <button onClick={() => setBanner(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}

      {activeSession ? (
        <Chat
          session={activeSession}
          connectionName={activeConnection.name}
          profile={profile}
          connected={connState === 'open'}
          onSend={sendPrompt}
          onInterrupt={interrupt}
          onAnswer={answerPrompt}
          onAttach={stageFiles}
          onDownload={downloadFile}
        />
      ) : (
        <div className="empty">
          <h2>No chat open</h2>
          <p>Pick a session from the drawer, or start a new chat.</p>
          <button className="primary" onClick={() => setDrawerOpen(true)}>
            Open sessions
          </button>
        </div>
      )}

      <Drawer
        open={drawerOpen}
        tab={drawerTab}
        onTab={setDrawerTab}
        sessions={store.sessions}
        order={store.order}
        activeId={store.activeId}
        profiles={profiles}
        profile={profile}
        loading={store.loadingList}
        liveCount={store.live.length}
        onClose={() => setDrawerOpen(false)}
        onOpenSession={openSession}
        onSelectProfile={(name) => {
          setProfile(name)
          profileRef.current = name
          if (activeConnectionRef.current) void storage.saveProfile(activeConnectionRef.current.id, name)
          setDrawerTab('sessions')
          void (async () => {
            const stored = await refreshDiscovery(name)
            // Switching bot resumes that bot's own conversation rather than
            // leaving the previous bot's chat on screen.
            await resumeLastChat(profiles, stored, name)
          })()
        }}
        onNewChat={newChat}
        onSettings={() => {
          setDrawerOpen(false)
          setSettingsOpen(true)
        }}
        onRefresh={refreshDiscovery}
      />
    </div>
  )
}
