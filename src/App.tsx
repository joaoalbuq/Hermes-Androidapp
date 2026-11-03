import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GatewayClient, type ConnectionState } from './lib/protocol/client'
import { PasswordAuthSession, CookieAuthSession, DEFAULT_PROVIDER } from './lib/protocol/auth'
import type { Credential } from './lib/protocol/types'
import {
  HANDLED_SERVER_REQUESTS,
  type OpenRequestEntry,
  type ProfileRow,
  type SessionActiveItem,
  type SessionAttachResult,
  type SessionListRow,
} from './lib/protocol/types'
import { initialStore, reducer } from './state'
import { useReducer } from 'react'
import * as storage from './lib/storage'
import Drawer from './components/Drawer'
import Chat from './components/Chat'
import SettingsScreen from './components/SettingsScreen'
import LoginScreen from './components/LoginScreen'

type Phase = 'loading' | 'setup' | 'main'
type DrawerTab = 'sessions' | 'bots'

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

  const attachSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (!client) return
    try {
      const result = await client.request<SessionAttachResult>('session.activate', {
        session_id: sessionId,
        // The bot this chat belongs to: without it the gateway resolves the
        // session against the default profile home.
        profile: profileRef.current,
        cols: null,
      })
      const id = result?.session_id || sessionId
      dispatch({ type: 'attach', sessionId: id, result, profile: profileRef.current })
      // Remember it so the next launch (on this device) and the next bot switch
      // land back in the same conversation.
      const connection = activeConnectionRef.current
      if (connection) void storage.saveLastSession(connection.id, profileRef.current, id)
      if (result?.inflight?.streaming) {
        setBanner('Attached to a turn already running on the gateway.')
      }
    } catch (err) {
      setBanner(`Could not attach: ${(err as Error).message}`)
    }
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
      const fromGateway = bot?.last_session?.session_id || null
      const newest = stored[0]?.id || null

      const target = saved || fromGateway || newest
      if (!target) return
      if (target === activeSessionRef.current) return

      dispatch({ type: 'active', sessionId: target })
      await attachSession(target)
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
          onEvent: (type, sessionId, payload) => {
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
            const sessionId = (params.session_id as string | undefined) || activeSessionRef.current
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
    [attachSession, refreshDiscovery, refreshProfiles, resumeLastChat],
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
      dispatch({ type: 'attach', sessionId: id, result, profile: profileRef.current })
      dispatch({ type: 'active', sessionId: id })
      void refreshDiscovery()
    } catch (err) {
      setBanner(`Could not create a chat: ${(err as Error).message}`)
    }
  }, [refreshDiscovery])

  const sendPrompt = useCallback(
    async (text: string, steer: boolean) => {
      const client = clientRef.current
      const sessionId = activeSessionRef.current
      if (!client || !sessionId) return
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
      dispatch({ type: 'localUser', sessionId, text })
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
    const sessionId = activeSessionRef.current
    if (!client || !sessionId) return
    try {
      await client.request('session.interrupt', { session_id: sessionId })
    } catch (err) {
      setBanner(`Interrupt failed: ${(err as Error).message}`)
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
