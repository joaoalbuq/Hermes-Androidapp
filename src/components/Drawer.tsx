import { useMemo, useState } from 'react'
import type { ProfileRow } from '../lib/protocol/types'
import type { SessionState } from '../state'

interface Props {
  open: boolean
  tab: 'sessions' | 'bots'
  onTab: (tab: 'sessions' | 'bots') => void
  sessions: Record<string, SessionState>
  order: string[]
  activeId: string | null
  profiles: ProfileRow[]
  profile: string | null
  loading: boolean
  liveCount: number
  onClose: () => void
  onOpenSession: (id: string) => void
  onSelectProfile: (name: string | null) => void
  onNewChat: () => void
  onSettings: () => void
  onRefresh: () => void
}

function relTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`
  return `${Math.round(diff / 86_400_000)}d`
}

export default function Drawer({
  open,
  tab,
  onTab,
  sessions,
  order,
  activeId,
  profiles,
  profile,
  loading,
  liveCount,
  onClose,
  onOpenSession,
  onSelectProfile,
  onNewChat,
  onSettings,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return order
      .map((id) => sessions[id])
      .filter((session): session is SessionState => !!session)
      .filter((session) => {
        if (!needle) return true
        if (session.title.toLowerCase().includes(needle)) return true
        if (session.preview.toLowerCase().includes(needle)) return true
        // Search across what this client has actually loaded.
        return session.items.some((item) => {
          if (item.kind === 'tool') return item.name.toLowerCase().includes(needle)
          return item.text.toLowerCase().includes(needle)
        })
      })
      .sort((a, b) => {
        const liveA = a.status === 'working' || a.status === 'starting' ? 1 : 0
        const liveB = b.status === 'working' || b.status === 'starting' ? 1 : 0
        if (liveA !== liveB) return liveB - liveA
        return b.lastActive - a.lastActive
      })
  }, [order, sessions, query])

  return (
    <>
      {open ? <div className="scrim" onClick={onClose} /> : null}
      <aside className={`drawer ${open ? 'drawer-open' : ''}`} aria-hidden={!open}>
        <div className="drawer-head">
          <div className="tabs">
            <button
              className={tab === 'sessions' ? 'tab tab-active' : 'tab'}
              onClick={() => onTab('sessions')}
            >
              Sessions
              {liveCount > 0 ? <span className="live-pill">{liveCount} live</span> : null}
            </button>
            <button className={tab === 'bots' ? 'tab tab-active' : 'tab'} onClick={() => onTab('bots')}>
              Bots
            </button>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {tab === 'sessions' ? (
          <>
            <div className="drawer-tools">
              <input
                className="search"
                placeholder="Search sessions"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button className="icon-button" onClick={onRefresh} aria-label="Refresh" title="Refresh">
                ⟳
              </button>
            </div>
            {profile ? (
              <button className="filter-chip" onClick={() => onSelectProfile(null)}>
                profile: {profile} ✕
              </button>
            ) : null}
            <div className="session-list">
              {rows.length === 0 && !loading ? (
                <p className="muted pad">No sessions discovered yet.</p>
              ) : null}
              {rows.map((session) => {
                const live = session.status === 'working' || session.status === 'starting'
                return (
                  <button
                    key={session.id}
                    className={`session-row ${session.id === activeId ? 'session-active' : ''}`}
                    onClick={() => onOpenSession(session.id)}
                  >
                    <div className="session-row-top">
                      <span className="session-title">{session.title || 'Untitled session'}</span>
                      {session.unread > 0 ? <span className="unread">{session.unread}</span> : null}
                      {live ? <span className="live-dot" title={session.status} /> : null}
                    </div>
                    <div className="session-row-bottom">
                      <span className="session-preview">{session.preview || ' '}</span>
                      <span className="session-meta">{relTime(session.lastActive)}</span>
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="drawer-foot">
              <button className="secondary grow" onClick={onNewChat}>
                ＋ New chat
              </button>
              <button className="secondary" onClick={onSettings}>
                Settings
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted pad">
              {profiles.length > 0
                ? `${profiles.length} bot${profiles.length === 1 ? '' : 's'} on this gateway. Choosing one opens its last chat — the same conversation the desktop app left off in.`
                : 'Bots are Hermes profiles, discovered from the gateway with profiles.list. Nothing here creates or edits one.'}
            </p>
            <div className="session-list">
              {profiles.length === 0 ? (
                <p className="muted pad">
                  No profile roster available from this gateway. Sessions still work; the roster needs{' '}
                  <code>profiles.list</code>.
                </p>
              ) : null}
              {[...profiles]
                .sort(
                  (a, b) =>
                    Number(!!b.is_default) - Number(!!a.is_default) ||
                    (a.display_name || a.name).localeCompare(b.display_name || b.name),
                )
                .map((row) => (
                <button
                  key={row.name}
                  className={`session-row ${profile === row.name ? 'session-active' : ''}`}
                  onClick={() => onSelectProfile(row.name)}
                >
                  <div className="session-row-top">
                    <span className="session-title">{row.display_name || row.name}</span>
                    {row.is_default ? <span className="badge">default</span> : null}
                    {profile === row.name ? <span className="badge">active</span> : null}
                  </div>
                  <div className="session-row-bottom">
                    <span className="session-preview">
                      {row.last_session?.title ? `↩ ${row.last_session.title}` : 'no chats yet'}
                    </span>
                    <span className="session-meta">{row.model || ''}</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="drawer-foot">
              <button className="secondary" onClick={() => onSelectProfile(null)}>
                All bots
              </button>
              <button className="secondary grow" onClick={onRefresh}>
                Refresh roster
              </button>
              <button className="secondary" onClick={onSettings}>
                Settings
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
