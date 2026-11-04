import { RpcCallError, type GatewayClient } from './client'
import {
  METHOD_NOT_FOUND,
  type CommandDispatchResult,
  type ModelCapabilities,
  type ModelOptionsResult,
  type ModelOptionProvider,
} from './types'

/**
 * Model and reasoning control.
 *
 * The gateway has no `session.set_model`: both live-pinned changes are slash
 * commands, and the RPC that runs a slash command is `command.dispatch` with
 * `{name, arg}` — the docs still show a `command` field, but the wire contract
 * (tui_gateway/contracts/tools_commands.py) is `name` + `arg` and its params are
 * `extra="forbid"`, so anything else is refused with 4000.
 *
 * - models      : `command.dispatch {name: "model", arg: "<model>"}` (persistent for the session)
 * - reasoning   : `command.dispatch {name: "reasoning", arg: "<level>"}` (session-scoped)
 * - bot default : `config.set {key: "model" | "reasoning", value, profile}` — writes the
 *                 profile's own config, so it applies to that bot's next chat rather than
 *                 re-pinning the live one.
 */

/** agent/reasoning_effort.py::EFFORT_LADDER — the vocabulary the gateway parses. */
export const REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export interface ModelChoice {
  provider: string
  providerName: string
  model: string
  isCurrentProvider: boolean
  reasoning: boolean
  canDisableReasoning: boolean | null
  unavailable: boolean
}

export interface ModelOptions {
  choices: ModelChoice[]
  model: string
  provider: string
}

const textOf = (result: CommandDispatchResult | null): string =>
  ((result?.output || result?.display || result?.notice || result?.message || '') as string).trim()

const isUnknownMethod = (err: unknown) =>
  err instanceof RpcCallError && err.code === METHOD_NOT_FOUND

function flatten(providers: ModelOptionProvider[], currentProvider: string): ModelChoice[] {
  const out: ModelChoice[] = []
  for (const provider of providers) {
    const models = Array.isArray(provider.models) ? provider.models : []
    const capabilities = (provider.capabilities || {}) as Record<string, ModelCapabilities>
    const unavailable = new Set(
      Array.isArray(provider.unavailable_models) ? provider.unavailable_models : [],
    )
    for (const model of models) {
      const caps = capabilities[model] || {}
      out.push({
        provider: provider.slug,
        providerName: provider.name || provider.slug,
        model,
        isCurrentProvider: provider.slug === currentProvider || !!provider.is_current,
        reasoning: caps.reasoning !== false,
        canDisableReasoning:
          typeof caps.can_disable_reasoning === 'boolean' ? caps.can_disable_reasoning : null,
        unavailable: unavailable.has(model),
      })
    }
  }
  return out
}

/**
 * The picker inventory.
 *
 * `session_id` matters: the gateway layers the session's live provider over the
 * catalog, so the row the chat is actually running on is reported as current.
 */
export async function loadModelOptions(
  client: GatewayClient,
  options: { profile: string | null; sessionId: string | null; refresh?: boolean },
): Promise<ModelOptions> {
  const params: Record<string, unknown> = {}
  if (options.profile) params.profile = options.profile
  if (options.sessionId) params.session_id = options.sessionId
  if (options.refresh) params.refresh = true
  const result = await client.request<ModelOptionsResult>('model.options', params)
  const providers = Array.isArray(result?.providers) ? result.providers : []
  return {
    choices: flatten(providers, result?.provider || ''),
    model: result?.model || '',
    provider: result?.provider || '',
  }
}

/** Run a slash command against the attached chat. */
async function dispatch(
  client: GatewayClient,
  options: { name: string; arg: string; sessionId: string; profile: string | null },
): Promise<string> {
  const params: Record<string, unknown> = {
    name: options.name,
    arg: options.arg,
    session_id: options.sessionId,
  }
  if (options.profile) params.profile = options.profile
  const result = await client.request<CommandDispatchResult>('command.dispatch', params)
  const text = textOf(result)
  // A slash command can report its own failure as output ("Unknown model …",
  // "not available for this profile"). Treating that as success is what left the
  // pill claiming a model the session was never switched to.
  if (/^\s*(unknown|invalid|error|failed|cannot|can't|no such|not available)\b/i.test(text)) {
    throw new Error(text)
  }
  return text
}

export interface ChangeResult {
  ok: boolean
  /** What the gateway said, ready to show. */
  message: string
  /** Which route actually applied it. */
  via: 'command' | 'config'
}

/**
 * Pin a model on the open chat.
 *
 * `/model` is the documented mid-session switch and is persistent for the
 * session. Only a gateway that has no `command.dispatch` at all falls back to
 * `config.set`, and the fallback addresses the session by its DURABLE id (config
 * is stored per session file) rather than the runtime handle.
 *
 * Any other refusal — unknown model, busy session, no live session — is surfaced.
 * Falling back on those was worse than an error: `config.set` resolved the target
 * differently and wrote a different scope, so a chat pick silently changed the
 * bot's default while the chat kept its model.
 */
export async function applyModel(
  client: GatewayClient,
  options: {
    /** Runtime handle of the live attach — what command.dispatch addresses. */
    sessionId: string
    /** Durable id, for the config route and error messages. */
    storedId?: string | null
    profile: string | null
    model: string
  },
): Promise<ChangeResult> {
  try {
    const message = await dispatch(client, {
      name: 'model',
      arg: options.model,
      sessionId: options.sessionId,
      profile: options.profile,
    })
    return { ok: true, message: message || `Model set to ${options.model}.`, via: 'command' }
  } catch (err) {
    if (!isUnknownMethod(err)) throw err
    try {
      const result = await client.request<{ warning?: string | null; confirm_message?: string | null }>(
        'config.set',
        {
          key: 'model',
          value: options.model,
          session_id: options.storedId || options.sessionId,
          ...(options.profile ? { profile: options.profile } : {}),
        },
      )
      return {
        ok: true,
        message: result?.warning || `Model set to ${options.model}.`,
        via: 'config',
      }
    } catch (fallbackErr) {
      throw new Error(
        `This gateway cannot change the model from the phone: ${(err as Error).message} / ${(fallbackErr as Error).message}`,
      )
    }
  }
}

/**
 * Set the reasoning effort on the open chat (`/reasoning <level>`).
 *
 * Same rule as the model: the config route is only for a gateway without
 * `command.dispatch`, so a refused level is reported rather than being retargeted
 * at whatever `config.set` resolves that session id to.
 */
export async function applyReasoning(
  client: GatewayClient,
  options: {
    /** Runtime handle of the live attach. */
    sessionId: string
    /** Durable id, for the config route. */
    storedId?: string | null
    profile: string | null
    level: string
  },
): Promise<ChangeResult> {
  try {
    const message = await dispatch(client, {
      name: 'reasoning',
      arg: options.level,
      sessionId: options.sessionId,
      profile: options.profile,
    })
    return { ok: true, message: message || `Reasoning set to ${options.level}.`, via: 'command' }
  } catch (err) {
    if (!isUnknownMethod(err)) throw err
    try {
      const result = await client.request<{ warning?: string | null }>('config.set', {
        key: 'reasoning',
        value: options.level,
        session_id: options.storedId || options.sessionId,
        ...(options.profile ? { profile: options.profile } : {}),
      })
      return {
        ok: true,
        message: result?.warning || `Reasoning set to ${options.level}.`,
        via: 'config',
      }
    } catch (fallbackErr) {
      throw new Error(
        `This gateway cannot change reasoning from the phone: ${(err as Error).message} / ${(fallbackErr as Error).message}`,
      )
    }
  }
}

export interface BotDefaultResult {
  ok: boolean
  /** True when the gateway wants an explicit confirm (expensive model). */
  confirmRequired: boolean
  message: string
}

/**
 * Persist a model on the bot itself, so its next chat starts on it.
 *
 * `config.set` with `profile` (and no `session_id`) writes that profile's home.
 * An expensive pick comes back as `confirm_required` instead of being written;
 * the caller retries with `confirm_expensive_model`.
 */
export async function saveBotModel(
  client: GatewayClient,
  options: { profile: string; model: string; confirm?: boolean },
): Promise<BotDefaultResult> {
  try {
    const result = await client.request<{
      confirm_required?: boolean
      confirm_message?: string | null
      warning?: string | null
      value?: string | null
    }>('config.set', {
      key: 'model',
      value: options.model,
      profile: options.profile,
      confirm_expensive_model: !!options.confirm,
    })
    if (result?.confirm_required) {
      return {
        ok: false,
        confirmRequired: true,
        message: result.confirm_message || `${options.model} needs an explicit confirmation.`,
      }
    }
    return {
      ok: true,
      confirmRequired: false,
      message: result?.warning || `Saved ${options.model} as the default for ${options.profile}.`,
    }
  } catch (err) {
    if (!isUnknownMethod(err)) throw err
    // Older builds only have the profile editor.
    const result = await client.request<{
      confirm_required?: boolean
      confirm_message?: string | null
    }>('profiles.configure', {
      profile: options.profile,
      model: options.model,
      confirm_expensive_model: !!options.confirm,
    })
    if (result?.confirm_required) {
      return {
        ok: false,
        confirmRequired: true,
        message: result.confirm_message || `${options.model} needs an explicit confirmation.`,
      }
    }
    return {
      ok: true,
      confirmRequired: false,
      message: `Saved ${options.model} as the default for ${options.profile}.`,
    }
  }
}

/** Persist a bot's reasoning effort (`config.set` scoped to the profile). */
export async function saveBotReasoning(
  client: GatewayClient,
  options: { profile: string; level: string },
): Promise<BotDefaultResult> {
  const result = await client.request<{ warning?: string | null }>('config.set', {
    key: 'reasoning',
    value: options.level,
    profile: options.profile,
  })
  return {
    ok: true,
    confirmRequired: false,
    message: result?.warning || `Saved reasoning ${options.level} for ${options.profile}.`,
  }
}
