import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionState } from '../state'
import { splitMedia, type StagedAttachment } from '../lib/protocol/files'
import Prompts from './Prompts'
import { shortModel } from './ModelSheet'

interface Props {
  session: SessionState
  connectionName: string
  profile: string | null
  connected: boolean
  onSend: (text: string, steer: boolean) => Promise<void> | void
  onInterrupt: () => Promise<void> | void
  onAnswer: (id: string, result: Record<string, unknown>) => void
  onAttach: (files: File[]) => Promise<StagedAttachment[]>
  onDownload: (path: string) => Promise<void> | void
  /** Live model + reasoning for the header pill. */
  model?: string
  reasoning?: string
  onOpenModel: () => void
}

/** Distance from the bottom (px) that still counts as "at the bottom". */
const FOLLOW_THRESHOLD = 72

/**
 * Assistant text plus any file the agent delivered.
 *
 * A tool can hand back a file as a `MEDIA:/path` tag in its prose. The tag is not
 * something to show the user, so it becomes a download chip instead.
 */
function MessageBody({
  text,
  onDownload,
}: {
  text: string
  onDownload: (path: string) => Promise<void> | void
}) {
  const { text: prose, files } = splitMedia(text)
  return (
    <>
      {prose ? <div className="bubble-text">{prose}</div> : null}
      {files.length > 0 ? (
        <div className="file-chips">
          {files.map((file) => (
            <button
              key={file.path}
              className="file-chip"
              title={file.path}
              onClick={() => void onDownload(file.path)}
            >
              <span className="file-chip-icon">⬇</span>
              <span className="file-chip-name">{file.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}

export default function Chat({
  session,
  connectionName,
  profile,
  connected,
  onSend,
  onInterrupt,
  onAnswer,
  onAttach,
  onDownload,
  model,
  reasoning,
  onOpenModel,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [follow, setFollow] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<StagedAttachment[]>([])
  const [staging, setStaging] = useState(false)
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

  /** Stage picked files now; they ride along with whatever is sent next. */
  const pickFiles = async (files: File[]) => {
    if (files.length === 0) return
    setStaging(true)
    try {
      const staged = await onAttach(files)
      if (staged.length > 0) setAttachments((list) => [...list, ...staged])
    } catch {
      // The App put the reason in the banner already.
    } finally {
      setStaging(false)
    }
  }

  const submit = async () => {
    const value = text.trim()
    if ((!value && attachments.length === 0) || sending) return
    setSending(true)
    setFollow(true)
    // A staged file is announced to the agent through its own reference line; the
    // queued image needs no text beyond whatever the user typed.
    const refs = attachments.map((attachment) => attachment.refText).filter(Boolean)
    const payload =
      [...refs, value].filter(Boolean).join('\n\n') || 'See the attached file.'
    setText('')
    setAttachments([])
    try {
      await onSend(payload, running)
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
                <MessageBody text={item.text} onDownload={onDownload} />
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
        <button className="model-pill" onClick={onOpenModel} title="Model and reasoning">
          <span className="model-pill-icon">◈</span>
          <span className="model-pill-model">{shortModel(model || '')}</span>
          <span className="model-pill-sep">·</span>
          <span className="model-pill-level">{reasoning || 'default'}</span>
        </button>
        {attachments.length > 0 || staging ? (
          <div className="attach-row">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="attach-chip">
                <span className="attach-chip-icon">{attachment.kind === 'image' ? '🖼' : '📄'}</span>
                <span className="attach-chip-name">{attachment.name}</span>
                <button
                  className="attach-chip-remove"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() =>
                    setAttachments((list) => list.filter((item) => item.id !== attachment.id))
                  }
                >
                  ✕
                </button>
              </span>
            ))}
            {staging ? <span className="attach-chip attach-chip-busy">uploading…</span> : null}
          </div>
        ) : null}
        <div className="composer">
          <input
            ref={fileInputRef}
            className="attach-input"
            type="file"
            multiple
            disabled={!connected}
            onChange={(event) => {
              const picked = Array.from(event.target.files || [])
              // Reset so picking the same file twice still fires a change event.
              event.target.value = ''
              void pickFiles(picked)
            }}
          />
          <button
            className="attach-button"
            aria-label="Attach a file"
            title="Attach a file"
            disabled={!connected || staging}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
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
          <button
            className="primary"
            disabled={!connected || (!text.trim() && attachments.length === 0) || sending}
            onClick={submit}
          >
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
