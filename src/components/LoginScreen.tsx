import { useState } from 'react'
import type { SavedConnection } from '../lib/storage'
import { signInWithWebView } from '../lib/protocol/auth'

interface Props {
  connection: SavedConnection
  onSignedIn: (cookie: string) => Promise<void> | void
  onCancel: () => void
}

type Phase = 'idle' | 'opening' | 'waiting' | 'verifying'

const PHASE_TEXT: Record<Phase, string> = {
  idle: '',
  opening: 'Opening the gateway sign-in page…',
  waiting: 'Waiting for you to sign in…',
  verifying: 'Checking the session…',
}

/**
 * Sign-in gate for a gated gateway.
 *
 * The login form is the gateway's own page, rendered in an in-app WebView, so the
 * password goes straight from the keyboard to the gateway: this app never sees it
 * and never stores it. What the app keeps afterwards is the session cookie, which
 * it trades for one-use WebSocket tickets.
 */
export default function LoginScreen({ connection, onSignedIn, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const busy = phase !== 'idle'

  const start = async () => {
    setError(null)
    setPhase('opening')
    try {
      const cookie = await signInWithWebView(connection.baseUrl, (next) => setPhase(next))
      setPhase('idle')
      await onSignedIn(cookie)
    } catch (err) {
      setPhase('idle')
      setError((err as Error).message || 'Sign-in failed')
    }
  }

  return (
    <div className="settings">
      <header className="topbar">
        <button className="icon-button" onClick={onCancel} aria-label="Cancel">
          ‹
        </button>
        <div className="topbar-title">
          <strong>Sign in</strong>
          <span className="topbar-sub">{connection.name}</span>
        </div>
      </header>

      <div className="settings-body">
        <div className="card">
          <h2>Sign in to {connection.name}</h2>
          <p className="muted">
            The next screen is your gateway's own login page. Your username and password go straight to
            <code> {connection.baseUrl}</code> — this app never sees them and never stores them.
          </p>

          <div className="test-result">
            <div className="leg">gateway: {connection.baseUrl}</div>
            <div className="leg">user: {connection.username || 'not signed in yet'}</div>
          </div>

          {error ? <div className="note note-error">{error}</div> : null}
          {busy ? <div className="note">{PHASE_TEXT[phase]}</div> : null}

          <div className="prompt-actions">
            <button className="primary" onClick={() => void start()} disabled={busy}>
              {busy ? 'Signing in…' : 'Open gateway sign-in'}
            </button>
            <button className="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>

          <p className="muted small">
            Signed in already? This screen only appears when the app has no session, or the old one
            expired. You can pre-approve nothing here — approvals still happen in the chat.
          </p>
        </div>
      </div>
    </div>
  )
}
