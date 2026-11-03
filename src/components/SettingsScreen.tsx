import { useEffect, useState } from 'react'
import * as storage from '../lib/storage'
import { testBothLegs, type TestResult } from '../lib/diagnostics'
import { normalizeBaseUrl } from '../lib/protocol/url'
import { DEFAULT_PROVIDER } from '../lib/protocol/auth'
import { DEFAULT_GATEWAY_NAME, DEFAULT_GATEWAY_URL } from '../config'
import type { ConnectionState } from '../lib/protocol/client'

interface Props {
  connections: storage.SavedConnection[]
  activeId: string | null
  onConnectionsChanged: (next: storage.SavedConnection[]) => Promise<void> | void
  onChoose: (id: string) => Promise<void> | void
  onClose?: () => void
  connectionState: ConnectionState
  connectionDetail: string
}

type SecretMode = 'secure' | 'plain' | 'none'

interface Draft {
  id: string | null
  name: string
  baseUrl: string
  authMode: 'token' | 'password' | 'signin'
  token: string
  username: string
  password: string
  provider: string
}

const emptyDraft: Draft = {
  id: null,
  name: DEFAULT_GATEWAY_NAME,
  baseUrl: DEFAULT_GATEWAY_URL,
  // Password is the default because it is the only mode that keeps you signed in
  // with no extra taps: the app re-signs in silently at every launch.
  authMode: 'password',
  token: '',
  username: '',
  password: '',
  provider: DEFAULT_PROVIDER,
}

export default function SettingsScreen({
  connections,
  activeId,
  onConnectionsChanged,
  onChoose,
  onClose,
  connectionState,
  connectionDetail,
}: Props) {
  const [draft, setDraft] = useState<Draft | null>(connections.length === 0 ? emptyDraft : null)
  const [modes, setModes] = useState<Record<string, SecretMode>>({})
  const [tests, setTests] = useState<Record<string, TestResult>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const next: Record<string, SecretMode> = {}
      for (const connection of connections) {
        next[connection.id] =
          connection.authMode === 'password'
            ? await storage.passwordMode(connection.id)
            : connection.authMode === 'signin'
              ? await storage.cookieMode(connection.id)
              : await storage.tokenMode(connection.id)
      }
      setModes(next)
    })()
  }, [connections])

  const startEdit = (connection: storage.SavedConnection) => {
    setError(null)
    setDraft({
      id: connection.id,
      name: connection.name,
      baseUrl: connection.baseUrl,
      authMode: connection.authMode || 'token',
      token: '',
      username: connection.username || '',
      password: '',
      provider: connection.provider || DEFAULT_PROVIDER,
    })
  }

  const save = async () => {
    if (!draft) return
    setError(null)
    let baseUrl: string
    try {
      baseUrl = normalizeBaseUrl(draft.baseUrl)
    } catch (err) {
      setError((err as Error).message)
      return
    }
    if (draft.authMode === 'password' && !draft.username.trim()) {
      setError('A username is required for password sign-in.')
      return
    }
    setBusy(true)
    try {
      const id = draft.id || storage.newConnectionId()
      const name = draft.name.trim() || new URL(baseUrl).host
      const username = draft.authMode === 'password' ? draft.username.trim() : undefined
      const provider = draft.authMode === 'password' ? draft.provider.trim() || DEFAULT_PROVIDER : undefined

      if (draft.authMode === 'password' && draft.password) {
        await storage.savePassword(id, draft.password)
      }
      // Secrets from an earlier mode must not linger: a stale token would be sent
      // as ?token= and silently rejected, and a saved password is pointless once
      // the login page is doing the work.
      if (draft.authMode === 'token') {
        await storage.removePassword(id)
        await storage.removeCookie(id)
        if (draft.token.trim()) await storage.saveToken(id, draft.token.trim())
      } else if (draft.authMode === 'password') {
        await storage.removeToken(id)
        await storage.removeCookie(id)
      } else {
        await storage.removeToken(id)
        await storage.removePassword(id)
      }

      const next: storage.SavedConnection[] = draft.id
        ? connections.map((connection) =>
            connection.id === id
              ? { ...connection, name, baseUrl, authMode: draft.authMode, username, provider }
              : connection,
          )
        : [...connections, { id, name, baseUrl, authMode: draft.authMode, username, provider }]
      await onConnectionsChanged(next)
      setDraft(null)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    const next = connections.filter((connection) => connection.id !== id)
    await storage.deleteConnection(id)
    await onConnectionsChanged(next)
  }

  const runTest = async (connection: storage.SavedConnection) => {
    const mode = connection.authMode || 'token'
    const [token, password, cookie] = await Promise.all([
      mode === 'token' ? storage.loadToken(connection.id) : Promise.resolve(''),
      mode === 'password' ? storage.loadPassword(connection.id) : Promise.resolve(''),
      mode === 'signin' ? storage.loadCookie(connection.id) : Promise.resolve(''),
    ])
    setBusy(true)
    try {
      const result = await testBothLegs({
        baseUrl: connection.baseUrl,
        authMode: mode,
        token,
        password,
        cookie,
        username: connection.username,
        provider: connection.provider,
      })
      setTests((current) => ({ ...current, [connection.id]: result }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings">
      <header className="topbar">
        {onClose ? (
          <button className="icon-button" onClick={onClose} aria-label="Back">
            ‹
          </button>
        ) : (
          <span className="icon-spacer" />
        )}
        <div className="topbar-title">
          <strong>Gateway</strong>
          <span className="topbar-sub">connect to a gateway you already run</span>
        </div>
      </header>

      <div className="settings-body">
        {connections.length === 0 ? (
          <div className="card">
            <h2>Connect to your Hermes gateway</h2>
            <p className="muted">
              This app is only a viewer. It does not create bots, profiles, or anything server-side.
              Point it at a running <code>hermes serve</code> backend and sign in.
            </p>
          </div>
        ) : null}

        {connections.map((connection) => {
          const test = tests[connection.id]
          const mode = modes[connection.id]
          const passwordMode = connection.authMode === 'password'
          return (
            <div key={connection.id} className={`card ${connection.id === activeId ? 'card-active' : ''}`}>
              <div className="card-head">
                <div>
                  <strong>{connection.name}</strong>
                  <div className="muted small">{connection.baseUrl}</div>
                </div>
                {connection.id === activeId ? <span className="badge">active</span> : null}
              </div>
              <div className="muted small">
                {connection.authMode === 'signin'
                  ? `gateway sign-in · session ${
                      mode === 'secure' ? 'saved (encrypted)' : mode === 'plain' ? 'saved (plain fallback)' : 'not signed in'
                    }`
                  : passwordMode
                    ? `sign-in: ${connection.username || 'no username'} · password ${
                        mode === 'secure' ? 'encrypted (Android Keystore)' : mode === 'plain' ? 'plain fallback' : 'not set'
                      }`
                    : `token: ${
                        mode === 'secure' ? 'encrypted (Android Keystore)' : mode === 'plain' ? 'plain fallback' : 'not set'
                      }`}
              </div>
              {test ? (
                <div className="test-result">
                  <div className={test.http.ok ? 'leg leg-ok' : 'leg leg-bad'}>
                    Sign-in: {test.http.detail}
                  </div>
                  <div className={test.ws.ok ? 'leg leg-ok' : 'leg leg-bad'}>
                    WebSocket: {test.ws.detail}
                  </div>
                  {!test.ws.ok && test.http.ok ? (
                    <p className="muted small">
                      The gateway answers but the WebSocket does not. That is usually a proxy, firewall, or the
                      gateway's auth/Origin guard blocking <code>/api/ws</code>.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="prompt-actions">
                <button className="primary" onClick={() => void onChoose(connection.id)}>
                  Use
                </button>
                <button className="secondary" onClick={() => void runTest(connection)} disabled={busy}>
                  Test
                </button>
                <button className="secondary" onClick={() => startEdit(connection)}>
                  Edit
                </button>
                <button className="danger" onClick={() => void remove(connection.id)}>
                  Remove
                </button>
              </div>
            </div>
          )
        })}

        {activeId ? (
          <p className="muted small pad">
            status: {connectionState}
            {connectionDetail ? ` — ${connectionDetail}` : ''}
          </p>
        ) : null}

        {draft ? (
          <div className="card">
            <h3>{draft.id ? 'Edit connection' : 'New connection'}</h3>
            <label className="field">
              <span>Name</span>
              <input
                value={draft.name}
                placeholder="Homelab"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Gateway URL</span>
              <input
                value={draft.baseUrl}
                placeholder={DEFAULT_GATEWAY_URL}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
              <small className="muted">
                Base URL of a running backend. Reverse-proxy path prefixes work, e.g. https://host/hermes.
              </small>
            </label>

            <div className="field">
              <span>Sign in with</span>
              <div className="segmented segmented-wrap">
                <button
                  type="button"
                  className={draft.authMode === 'password' ? 'seg seg-on' : 'seg'}
                  onClick={() => setDraft({ ...draft, authMode: 'password' })}
                >
                  Username &amp; password
                </button>
                <button
                  type="button"
                  className={draft.authMode === 'token' ? 'seg seg-on' : 'seg'}
                  onClick={() => setDraft({ ...draft, authMode: 'token' })}
                >
                  Session token
                </button>
                <button
                  type="button"
                  className={draft.authMode === 'signin' ? 'seg seg-on' : 'seg'}
                  onClick={() => setDraft({ ...draft, authMode: 'signin' })}
                >
                  Gateway sign-in
                </button>
              </div>
              <small className="muted">
                {draft.authMode === 'password'
                  ? 'Stays signed in: the password is kept in encrypted storage and the app signs in by itself each time you open it. No login page, no tickets to paste.'
                  : draft.authMode === 'token'
                    ? 'For a gateway started with --insecure, or one bound to loopback that you reach over a tunnel.'
                    : 'Optional: opens the gateway\'s own login page in the app and keeps only the session cookie, so no password is stored. Requires signing in again when the session expires.'}
              </small>
            </div>

            {draft.authMode === 'signin' ? (
              <div className="note">
                You will sign in on your gateway's page after saving. The app only keeps the resulting
                session cookie, so no password ever reaches this app's storage.
              </div>
            ) : null}

            {draft.authMode === 'password' ? (
              <>
                <label className="field">
                  <span>Username</span>
                  <input
                    value={draft.username}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={draft.password}
                    placeholder={draft.id ? 'Leave blank to keep the saved password' : ''}
                    autoComplete="off"
                    onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                  />
                  <small className="muted">
                    Kept in encrypted local storage (Android Keystore) and only ever sent to this gateway's
                    sign-in endpoint. The app signs in with it silently on launch and again whenever the
                    session expires, so you never see a login screen.
                  </small>
                </label>
              </>
            ) : draft.authMode === 'token' ? (
              <label className="field">
                <span>Session token</span>
                <input
                  type="password"
                  value={draft.token}
                  placeholder={draft.id ? 'Leave blank to keep the saved token' : 'Paste the gateway session token'}
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, token: event.target.value })}
                />
                <small className="muted">
                  Stored in encrypted local storage and never logged. It travels to the gateway as
                  <code> ?token=</code> on the WebSocket, because that is the only credential the WS upgrade
                  reads — use TLS so it stays out of proxy logs.
                </small>
              </label>
            ) : null}

            {error ? <div className="note note-error">{error}</div> : null}
            <div className="prompt-actions">
              <button className="primary" onClick={() => void save()} disabled={busy}>
                Save connection
              </button>
              {connections.length > 0 ? (
                <button className="secondary" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <button className="secondary wide" onClick={() => setDraft(emptyDraft)}>
            ＋ Add connection
          </button>
        )}

        <details className="card">
          <summary>What this app does and does not do</summary>
          <ul className="muted small list">
            <li>Reads sessions and the live roster from the gateway; nothing is configured here.</li>
            <li>Attaches to a turn already running so you can follow it from the phone.</li>
            <li>Answers approvals and clarify questions raised on the gateway.</li>
            <li>No bot or profile creation, no rewind/edit-and-regenerate, no server-side installs.</li>
          </ul>
        </details>
      </div>
    </div>
  )
}
