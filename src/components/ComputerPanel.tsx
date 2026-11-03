import type { ConnectionState } from '../lib/protocol/client'
import type { GatewayStatusResult } from '../lib/protocol/auth'
import type { KeepAliveState } from '../lib/native/keepalive'

interface Props {
  connectionName: string
  baseUrl: string
  authMode?: string
  connState: ConnectionState
  connDetail: string
  status: GatewayStatusResult | null
  loading: boolean
  statusAt: number | null
  keepAlive: KeepAliveState
  profile: string | null
  sessionCount: number
  liveCount: number
  onRefresh: () => void
  onWake: () => void
  onRequestExemption: () => void
}

const AUTH_LABEL: Record<string, string> = {
  token: 'session token',
  password: 'password sign-in',
  signin: 'browser sign-in',
}

function uptime(seconds?: number): string {
  if (!seconds || seconds < 0) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${Math.max(1, minutes)}m`
}

function runningBots(status: GatewayStatusResult | null): string {
  const profiles = status?.data?.profiles
  if (!profiles) return '—'
  const rows = Array.isArray(profiles)
    ? profiles
    : Object.entries(profiles as Record<string, unknown>).map(([name, value]) => ({
        name,
        running: !!(value && typeof value === 'object' && (value as { running?: boolean }).running),
      }))
  const live = rows.filter((row) => row && row.running).length
  return `${live} / ${rows.length}`
}

function ago(at: number | null): string {
  if (!at) return 'never'
  const diff = Date.now() - at
  if (diff < 5_000) return 'just now'
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  return `${Math.round(diff / 60_000)}m ago`
}

/**
 * The Hermes computer, seen from the phone.
 *
 * Sessions and turns come over the WebSocket; the machine running the gateway is
 * visible only through its own HTTP `/api/status`, so this panel combines both:
 * the transport state the app is holding, and what the host says about itself.
 * "Wake" redials and re-reads the status — the one action that can actually
 * bring a sleeping gateway computer back into view from here.
 */
export default function ComputerPanel({
  connectionName,
  baseUrl,
  authMode,
  connState,
  connDetail,
  status,
  loading,
  statusAt,
  keepAlive,
  profile,
  sessionCount,
  liveCount,
  onRefresh,
  onWake,
  onRequestExemption,
}: Props) {
  const reachable = connState === 'open'
  const hostStatus = status?.error ? status.error : status?.data?.status || (status ? 'ok' : '—')

  return (
    <div className="computer-panel">
      <div className={`computer-hero ${reachable ? 'computer-hero-ok' : 'computer-hero-bad'}`}>
        <div className="computer-hero-row">
          <span className={`live-dot ${reachable ? '' : 'live-dot-bad'}`} />
          <strong>{reachable ? 'Gateway connected' : `Gateway ${connState}`}</strong>
        </div>
        <p className="computer-hero-sub">
          {connectionName} · {AUTH_LABEL[authMode || 'token'] || authMode}
        </p>
        <code className="computer-url">{baseUrl}</code>
        {connDetail && !reachable ? <p className="computer-detail">{connDetail}</p> : null}
      </div>

      <div className="stat-grid">
        <div className="stat">
          <span className="stat-label">Host status</span>
          <span className="stat-value">{hostStatus}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Version</span>
          <span className="stat-value">{status?.data?.version || '—'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Uptime</span>
          <span className="stat-value">{uptime(status?.data?.uptime_s)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Bots running</span>
          <span className="stat-value">{runningBots(status)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Chats loaded</span>
          <span className="stat-value">
            {sessionCount}
            {liveCount > 0 ? ` · ${liveCount} live` : ''}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Current bot</span>
          <span className="stat-value">{profile || 'default'}</span>
        </div>
      </div>

      <p className="muted computer-note">
        Host status is read from <code>/api/status</code> — {ago(statusAt)}.
      </p>

      <div className="panel-actions">
        <button className="primary grow" onClick={onWake} disabled={loading}>
          {reachable ? 'Wake & re-sync' : 'Wake computer'}
        </button>
        <button className="secondary" onClick={onRefresh} disabled={loading}>
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      <div className="panel-card">
        <div className="panel-card-head">
          <strong>Background connection</strong>
          <span className={`badge ${keepAlive.running ? 'badge-ok' : ''}`}>
            {keepAlive.supported ? (keepAlive.running ? 'on' : 'off') : 'n/a'}
          </span>
        </div>
        <p className="muted">
          {keepAlive.supported
            ? 'A foreground service holds the socket open while the phone is locked, so a turn that finishes in the background lands in this chat.'
            : 'Only the Android app can hold the connection open; in a browser the tab must stay awake.'}
        </p>
        {keepAlive.supported && !keepAlive.exempt ? (
          <>
            <p className="muted">
              Android can still freeze the app to save power. Allow it to keep running in the
              background for long locks.
            </p>
            <button className="secondary wide" onClick={onRequestExemption}>
              Allow background
            </button>
          </>
        ) : null}
        {keepAlive.supported && keepAlive.exempt ? (
          <p className="muted small">Exempt from battery optimisation.</p>
        ) : null}
      </div>
    </div>
  )
}
