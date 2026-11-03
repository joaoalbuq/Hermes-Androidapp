import { useMemo } from 'react'
import { REASONING_LEVELS, type ModelChoice, type ModelOptions } from '../lib/protocol/models'

interface Props {
  open: boolean
  profile: string | null
  model: string
  provider: string
  reasoning: string
  reasoningWire: string
  options: ModelOptions | null
  loading: boolean
  busy: boolean
  error: string | null
  notice: string | null
  scope: 'chat' | 'bot'
  onScope: (scope: 'chat' | 'bot') => void
  /** Set when the gateway wants an expensive bot-scope pick confirmed. */
  confirm: { model: string; message: string } | null
  onConfirm: () => void
  onCancelConfirm: () => void
  onRefresh: () => void
  onPickModel: (choice: ModelChoice) => void
  onPickReasoning: (level: string) => void
  onClose: () => void
}

/** Short label for a model id like "anthropic/claude-sonnet-4.6" or "gpt-5.5". */
export function shortModel(model: string): string {
  if (!model) return 'model'
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return bare.length > 22 ? `${bare.slice(0, 21)}…` : bare
}

/**
 * Model + reasoning picker for the open chat or the bot itself.
 *
 * The inventory comes from `model.options`; a pick on the chat runs `/model` or
 * `/reasoning` against the attached session, and the bot scope persists through
 * `config.set` against that profile, which takes effect on the bot's next chat.
 */
export default function ModelSheet({
  open,
  profile,
  model,
  provider,
  reasoning,
  reasoningWire,
  options,
  loading,
  busy,
  error,
  notice,
  scope,
  onScope,
  confirm,
  onConfirm,
  onCancelConfirm,
  onRefresh,
  onPickModel,
  onPickReasoning,
  onClose,
}: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; choices: ModelChoice[] }>()
    for (const choice of options?.choices || []) {
      const row = map.get(choice.provider) || { name: choice.providerName, choices: [] }
      row.choices.push(choice)
      map.set(choice.provider, row)
    }
    return [...map.entries()].map(([slug, value]) => ({ slug, ...value }))
  }, [options])

  if (!open) return null

  const currentReasoning = reasoning || 'default'
  const clamped = reasoningWire && reasoningWire !== reasoning ? reasoningWire : ''

  return (
    <>
      <div className="scrim sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label="Model and reasoning">
        <div className="sheet-head">
          <div>
            <strong>Model &amp; reasoning</strong>
            <p className="muted small">
              {model ? `${provider ? `${provider} · ` : ''}${shortModel(model)}` : 'no live model reported'}
              {currentReasoning ? ` · reasoning ${currentReasoning}` : ''}
              {clamped ? ` (sends ${clamped})` : ''}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="sheet-scope">
          <button
            className={`segment ${scope === 'chat' ? 'segment-active' : ''}`}
            onClick={() => onScope('chat')}
          >
            This chat
          </button>
          <button
            className={`segment ${scope === 'bot' ? 'segment-active' : ''}`}
            onClick={() => onScope('bot')}
          >
            {profile ? `Bot: ${profile}` : 'This bot'}
          </button>
        </div>

        <p className="muted small sheet-note">
          {scope === 'chat'
            ? 'Applies to the open conversation right now — the same switch /model and /reasoning make in the desktop app.'
            : 'Saved on the bot, so its next chat starts here. The open conversation keeps what it has until you change it above.'}
        </p>

        <div className="sheet-body">
          {loading ? <p className="muted pad">Reading the model list…</p> : null}
          {!loading && groups.length === 0 ? (
            <p className="muted pad">
              This gateway returned no model inventory. <code>model.options</code> may be disabled, or
              the provider is still being probed.
            </p>
          ) : null}

          {groups.map((group) => (
            <div key={group.slug} className="model-group">
              <div className="model-group-name">
                {group.name}
                {group.slug === provider ? <span className="badge">current</span> : null}
              </div>
              {group.choices.map((choice) => {
                const active = choice.model === model
                return (
                  <button
                    key={`${choice.provider}:${choice.model}`}
                    className={`model-row ${active ? 'model-row-active' : ''}`}
                    disabled={busy || choice.unavailable}
                    onClick={() => onPickModel(choice)}
                    title={choice.model}
                  >
                    <span className="model-radio">{active ? '●' : '○'}</span>
                    <span className="model-name">{choice.model}</span>
                    {choice.reasoning ? <span className="model-tag">⌁</span> : null}
                    {choice.unavailable ? <span className="model-tag">unavailable</span> : null}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="sheet-reasoning">
          <div className="model-group-name">Reasoning effort</div>
          <div className="reasoning-row">
            {REASONING_LEVELS.map((level) => (
              <button
                key={level}
                className={`chip ${currentReasoning === level ? 'chip-active' : ''}`}
                disabled={busy}
                onClick={() => onPickReasoning(level)}
              >
                {level}
              </button>
            ))}
          </div>
          <p className="muted small">
            Hermes clamps the level to what the current route accepts; a stronger request never
            silently becomes a weaker one.
          </p>
        </div>

        {confirm ? (
          <div className="sheet-confirm">
            <p>{confirm.message}</p>
            <div className="sheet-actions">
              <button className="secondary grow" onClick={onCancelConfirm}>
                Cancel
              </button>
              <button className="primary" onClick={onConfirm} disabled={busy}>
                Use {shortModel(confirm.model)}
              </button>
            </div>
          </div>
        ) : null}

        {notice ? <p className="sheet-notice">{notice}</p> : null}
        {error ? <p className="sheet-error">{error}</p> : null}

        <div className="sheet-actions">
          <button className="secondary grow" onClick={onRefresh} disabled={loading || busy}>
            {loading ? 'Refreshing…' : 'Refresh list'}
          </button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  )
}
