import { useState } from 'react'
import type { ClarifyQuestion, OpenRequestEntry } from '../lib/protocol/types'

interface Props {
  prompts: OpenRequestEntry[]
  onAnswer: (id: string, result: Record<string, unknown>) => void
}

const APPROVAL_LABELS: Record<string, string> = {
  once: 'Allow once',
  session: 'Allow for session',
  always: 'Always allow',
  deny: 'Deny',
}

export default function Prompts({ prompts, onAnswer }: Props) {
  if (prompts.length === 0) return null
  return (
    <div className="prompts">
      {prompts.map((entry) => {
        if (entry.method === 'approval') {
          return <ApprovalCard key={entry.id} entry={entry} onAnswer={onAnswer} />
        }
        if (entry.method === 'clarify') {
          return <ClarifyCard key={entry.id} entry={entry} onAnswer={onAnswer} />
        }
        return <ValueCard key={entry.id} entry={entry} onAnswer={onAnswer} />
      })}
    </div>
  )
}

interface CardProps {
  entry: OpenRequestEntry
  onAnswer: (id: string, result: Record<string, unknown>) => void
}

function ApprovalCard({ entry, onAnswer }: CardProps) {
  const params = entry.params as {
    command?: string
    description?: string
    choices?: string[]
    tool_name?: string
  }
  const choices = params.choices?.length ? params.choices : ['once', 'session', 'always', 'deny']
  return (
    <div className="prompt-card prompt-warn">
      <div className="prompt-head">
        <span className="prompt-kind">Approval needed</span>
        {params.tool_name ? <span className="badge">{params.tool_name}</span> : null}
      </div>
      {params.command ? <pre className="prompt-command">{params.command}</pre> : null}
      {params.description ? <p className="prompt-text">{params.description}</p> : null}
      <div className="prompt-actions">
        {choices.map((choice) => (
          <button
            key={choice}
            className={choice === 'deny' ? 'danger' : 'primary'}
            onClick={() => onAnswer(entry.id, { choice })}
          >
            {APPROVAL_LABELS[choice] || choice}
          </button>
        ))}
      </div>
    </div>
  )
}

function ClarifyCard({ entry, onAnswer }: CardProps) {
  const params = entry.params as { questions?: ClarifyQuestion[] }
  const questions = params.questions || []
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const setAnswer = (qid: string, value: string) => {
    setAnswers((current) => ({ ...current, [qid]: value }))
  }

  const toggleChoice = (question: ClarifyQuestion, choice: string) => {
    const current = answers[question.qid] || ''
    const parts = current ? current.split(', ') : []
    const next = parts.includes(choice)
      ? parts.filter((part) => part !== choice)
      : question.multi_select
        ? [...parts, choice]
        : [choice]
    setAnswer(question.qid, next.join(', '))
  }

  const ready = questions.every((question) => (answers[question.qid] || '').trim().length > 0)

  return (
    <div className="prompt-card prompt-info">
      <div className="prompt-head">
        <span className="prompt-kind">The agent is asking</span>
      </div>
      {questions.map((question) => {
        const selected = (answers[question.qid] || '').split(', ').filter(Boolean)
        return (
          <div key={question.qid} className="prompt-question">
            <p className="prompt-text">{question.question}</p>
            {question.choices?.length ? (
              <div className="chips">
                {question.choices.map((choice) => (
                  <button
                    key={choice}
                    className={selected.includes(choice) ? 'chip chip-on' : 'chip'}
                    onClick={() => toggleChoice(question, choice)}
                  >
                    {choice}
                  </button>
                ))}
              </div>
            ) : (
              <input
                className="prompt-input"
                placeholder="Your answer"
                value={answers[question.qid] || ''}
                onChange={(event) => setAnswer(question.qid, event.target.value)}
              />
            )}
          </div>
        )
      })}
      <div className="prompt-actions">
        <button className="secondary" onClick={() => onAnswer(entry.id, {})}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={!ready}
          onClick={() => {
            const payload: Record<string, string> = {}
            for (const question of questions) payload[question.qid] = answers[question.qid] || ''
            onAnswer(entry.id, { answers: payload })
          }}
        >
          Send answer
        </button>
      </div>
    </div>
  )
}

function ValueCard({ entry, onAnswer }: CardProps) {
  const params = entry.params as { prompt?: string; description?: string; request_id?: string }
  const [value, setValue] = useState('')
  const title =
    entry.method === 'sudo'
      ? 'Sudo password'
      : entry.method === 'secret'
        ? 'Secret required'
        : entry.method.startsWith('vault')
          ? 'Vault unlock'
          : entry.method
  return (
    <div className="prompt-card prompt-warn">
      <div className="prompt-head">
        <span className="prompt-kind">{title}</span>
      </div>
      {params.prompt || params.description ? (
        <p className="prompt-text">{params.prompt || params.description}</p>
      ) : null}
      <input
        className="prompt-input"
        type="password"
        autoComplete="off"
        placeholder="Value"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="prompt-actions">
        <button className="secondary" onClick={() => onAnswer(entry.id, { value: '' })}>
          Skip
        </button>
        <button className="primary" disabled={!value} onClick={() => onAnswer(entry.id, { value })}>
          Submit
        </button>
      </div>
    </div>
  )
}
