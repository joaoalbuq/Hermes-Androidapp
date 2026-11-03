import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionState } from '../state'
import Prompts from './Prompts'

interface Props {
  session: SessionState
  connectionName: string
  profile: string | null
  connected: boolean
  onSend: (text: string, steer: boolean) => Promise<void> | void
  onInterrupt: () => Promise<void> | void
  onAnswer: (id: string, result: Record<string, unknown>) => void
}

/** Distance from the bottom (px) that still counts as "at the bottom". */
const FOLLOW_THRESHOLD = 72

export default function Chat({
  session,
  connectionName,
  profile,
  connected,
  onSend,
  onInterrupt,
  onAnswer,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const running = session.running || session.streaming

  // Scroll-follow, copied from the desktop's behaviour: stay pinned while the
  // reader is at the bottom, hold position the moment they scroll up, and never
  // yank them back without an explicit jump.
  const handleScroll = () => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    setFollow(distance < FOLLOW_THRESHOLD)
  }

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    if (follow) element.scrollTop = element.scrollHeight
  }, [session.items, session.streamText, session.prompts, follow])

  useEffect(() => {
    setFollow(true)
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [session.id])

  const jumpToBottom = () => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    setFollow(true)
  }

  const submit = async () => {
    const value = text.trim()
    if (!value || sending) return
    setSending(true)
    setFollow(true)
    setText('')
    try {
      await onSend(value, running)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef} onScroll={handleScroll}>
        <div className="chat-meta">
          {connectionName}
          {profile ? ` · ${profile}` : ''} · {session.model || 'model unknown'}
        </div>

        {session.items.map((item) => {
          if (item.kind === 'user') {
            return (
              <div key={item.id} className="bubble bubble-user">
                {item.text}
              </div>
            )
          }
          if (item.kind === 'assistant') {
            return (
              <div key={item.id} className="bubble bubble-assistant">
                {item.text}
              </div>
            )
          }
          if (item.kind === 'system') {
            return (
              <div key={item.id} className={`note ${item.tone === 'error' ? 'note-error' : ''}`}>
                {item.text}
              </div>
            )
          }
          return (
            <div key={item.id} className={`tool ${item.status === 'running' ? 'tool-live' : ''}`}>
              <div className="tool-head">
                <span className="tool-dot" />
                <span className="tool-name">{item.name}</span>
                <span className="tool-state">
                  {item.status === 'running'
                    ? 'running'
                    : item.durationS
                      ? `${item.durationS.toFixed(1)}s`
                      : 'done'}
                </span>
              </div>
              {item.detail ? <div className="tool-detail">{item.detail}</div> : null}
              {item.status === 'done' && item.resultText ? (
                <div className="tool-result">{item.resultText.slice(0, 600)}</div>
              ) : null}
            </div>
          )
        })}

        {session.streaming ? (
          <div className="bubble bubble-assistant bubble-stream">
            {session.streamText || <span className="thinking">thinking…</span>}
            <span className="caret" />
          </div>
        ) : null}

        {session.prompts.length === 0 && running ? <div className="note">working on the gateway…</div> : null}
        <div className="scroll-pad" />
      </div>

      {!follow ? (
        <button className="jump" onClick={jumpToBottom}>
          ↓ Jump to latest
        </button>
      ) : null}

      <div className="composer-wrap">
        <Prompts prompts={session.prompts} onAnswer={onAnswer} />
        <div className="composer">
          <textarea
            className="composer-input"
            rows={1}
            placeholder={
              !connected
                ? 'Reconnecting…'
                : running
                  ? 'Steer the running turn…'
                  : 'Message the agent…'
            }
            value={text}
            disabled={!connected}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          {running ? (
            <button className="danger" onClick={() => void onInterrupt()}>
              Stop
            </button>
          ) : null}
          <button className="primary" disabled={!connected || !text.trim() || sending} onClick={submit}>
            {running ? 'Steer' : 'Send'}
          </button>
        </div>
        <div className="composer-hint">
          {session.streaming ? 'streaming live' : running ? 'turn running' : 'idle'} · session{' '}
          {session.id.slice(0, 12)} · attached {session.attached ? 'yes' : 'no'}
        </div>
      </div>
    </div>
  )
}
