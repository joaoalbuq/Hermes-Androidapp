#!/usr/bin/env node
/**
 * Hermes gateway probe.
 *
 * Step 1 of the brief: prove the wire protocol before any UI exists.
 *
 * It speaks the same protocol as the Desktop app:
 *   ws(s)://<base>/api/ws?token=<token>
 *   gateway.ready -> client.capabilities{server_requests:true}
 *   -> session.list / session.active_list -> session.activate
 *
 * Usage:
 *   node probe/probe.mjs --url http://homelab.lan:9119 --token <token>
 *   HERMES_GATEWAY_URL=... HERMES_GATEWAY_TOKEN=... node probe/probe.mjs
 *   node probe/probe.mjs --url ... --token ... --watch 30     # keep streaming 30s
 *   node probe/probe.mjs --url ... --token ... --session <id> --activate
 *
 * Exit codes: 0 ok, 1 usage/error, 2 transport failed, 3 protocol failed.
 */
// Self-contained on purpose: the probe must run against a bare Node install, with
// no build step and nothing imported from the app bundle.
function normalizeBaseUrl(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) throw new Error('gateway URL is empty')
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('gateway URL must start with http:// or https://')
  }
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function buildWsUrl(baseUrl, credential) {
  const url = new URL(normalizeBaseUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/ws`
  const cred = typeof credential === 'string' ? { kind: 'token', value: credential } : credential
  if (cred?.value) url.searchParams.set(cred.kind === 'ticket' ? 'ticket' : 'token', cred.value)
  return url.toString()
}

/**
 * Gated gateways (auth_required) take no static token. Sign in with the password
 * provider, keep the session cookie, and mint a one-use ticket to dial with.
 */
async function signIn(baseUrl, { provider, username, password }) {
  const base = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${base}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: provider || 'basic', username, password }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`sign-in refused (${response.status}) ${body.slice(0, 200)}`)
  }
  const raw = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || '']
  const cookie = raw
    .map((entry) => String(entry).split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
  if (!cookie) throw new Error('sign-in succeeded but the gateway sent no session cookie')
  return cookie
}

async function mintTicket(baseUrl, cookie) {
  const base = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${base}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`ticket refused (${response.status}) ${body.slice(0, 200)}`)
  }
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  const ticket = data && (data.ticket || data.ws_ticket || data.token)
  if (!ticket) throw new Error(`gateway returned no ticket: ${JSON.stringify(data).slice(0, 200)}`)
  return ticket
}

function parseArgs(argv) {
  const out = { watch: 0, activate: false, provider: 'basic' }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    switch (arg) {
      case '--url':
        out.url = next()
        break
      case '--token':
        out.token = next()
        break
      case '--user':
        out.user = next()
        break
      case '--password':
        out.password = next()
        break
      case '--provider':
        out.provider = next()
        break
      case '--session':
        out.session = next()
        break
      case '--watch':
        out.watch = Number(next())
        break
      case '--activate':
        out.activate = true
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  out.url = out.url || process.env.HERMES_GATEWAY_URL || ''
  out.token = out.token || process.env.HERMES_GATEWAY_TOKEN || ''
  out.user = out.user || process.env.HERMES_GATEWAY_USER || ''
  out.password = out.password || process.env.HERMES_GATEWAY_PASSWORD || ''
  return out
}

const USAGE = `
Hermes gateway probe

  node probe/probe.mjs --url <http(s)://host[:port][/prefix]> --token <token> [options]
  node probe/probe.mjs --url <url> --user <name> --password <pass> [options]

  --token is for an --insecure / loopback gateway (the dashboard session token).
  --user/--password is for a gated gateway (auth_required): the probe signs in at
  POST /auth/password-login, mints a one-use ticket at POST /api/auth/ws-ticket and
  dials /api/ws?ticket=… — which is the only credential a gated gateway accepts.

Options
  --provider <name>  dashboard auth provider for --user (default basic)
  --session <id>     attach to this session instead of the first live one
  --activate         attach even when session.active_list is empty
  --watch <secs>     stay connected and print events for this long (default 0)
  --help             this text

Environment: HERMES_GATEWAY_URL, HERMES_GATEWAY_TOKEN, HERMES_GATEWAY_USER,
             HERMES_GATEWAY_PASSWORD
`

const json = (value) => JSON.stringify(value, null, 2)
const short = (value, max = 220) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ---------------------------------------------------------------- HTTP leg ---

async function probeHttp(baseUrl, headers, timeoutMs = 8000) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/status`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const body = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      /* not JSON */
    }
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      url,
      body: parsed ?? body.slice(0, 400),
    }
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, url, error: err.message }
  } finally {
    clearTimeout(timer)
  }
}

// ------------------------------------------------------------ WebSocket leg ---

async function probeWs({ baseUrl, credential, session, activate, watchSeconds }) {
  const wsUrl = buildWsUrl(baseUrl, credential)
  // Never print the credential: show the URL with it redacted.
  const redacted = wsUrl.replace(/([?&](?:token|ticket)=)[^&]*/, '$1<redacted>')
  console.log(`\n--- WebSocket leg ---`)
  console.log(`dial  ${redacted}`)

  const pending = new Map()
  let nextId = 1
  const serverRequests = []
  const answered = []
  const events = []
  let capabilities = null
  let readyPayload = null

  // The credential rides in the query string: the gateway's WS upgrade reads
  // ?token= or ?ticket=, and a WebSocket cannot set X-Hermes-Session-Token.
  const ws = new WebSocket(wsUrl)

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not open within 12s')), 12000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = (event) => {
      clearTimeout(timer)
      reject(new Error(`socket error before open${event?.message ? `: ${event.message}` : ''}`))
    }
  })

  const send = (frame) => ws.send(JSON.stringify(frame))

  const request = (method, params = {}, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      send({ jsonrpc: '2.0', id, method, params })
    })

  const ready = new Promise((resolve) => {
    ws.onmessage = (message) => {
      let frame
      try {
        frame = JSON.parse(message.data)
      } catch {
        return
      }
      // event notifications
      if (frame.method === 'event' && frame.params) {
        const { type, session_id: sid, payload } = frame.params
        events.push({ type, sid, payload })
        if (type === 'gateway.ready') {
          readyPayload = payload || {}
          resolve(readyPayload)
          return
        }
        if (type === 'message.delta') {
          process.stdout.write(payload?.text ? payload.text : '')
        } else if (type === 'message.complete') {
          console.log(`\n[event] message.complete status=${payload?.status ?? '?'} text=${short(payload?.text, 160)}`)
        } else if (type === 'tool.start' || type === 'tool.complete' || type === 'error' || type === 'request.cancel') {
          console.log(`[event] ${type} ${short(payload)}`)
        }
        return
      }
      // server -> client request: answer approval/clarify, refuse the rest
      if (frame.id !== undefined && frame.method) {
        serverRequests.push(frame)
        console.log(`\n[server request] ${frame.method} id=${frame.id} ${short(frame.params)}`)
        if (frame.method === 'approval') {
          send({ jsonrpc: '2.0', id: frame.id, result: { choice: 'deny' } })
          answered.push({ id: frame.id, method: frame.method, result: { choice: 'deny' } })
          console.log(`  -> answered deny`)
        } else if (frame.method === 'clarify') {
          send({ jsonrpc: '2.0', id: frame.id, result: {} })
          answered.push({ id: frame.id, method: frame.method, result: {} })
          console.log(`  -> answered cancel-all`)
        } else {
          send({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32601, message: 'probe does not implement this method' },
          })
          answered.push({ id: frame.id, method: frame.method, error: -32601 })
          console.log(`  -> refused -32601`)
        }
        return
      }
      // response to one of our requests
      const record = pending.get(frame.id)
      if (!record) return
      pending.delete(frame.id)
      clearTimeout(record.timer)
      if (frame.error) record.reject(Object.assign(new Error(frame.error.message), { rpc: frame.error }))
      else record.resolve(frame.result)
    }
  })

  opened.catch(() => {})

  const close = () => {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }

  try {
    await opened
    console.log('socket open')

    // THE handshake bit. Without this the gateway fails every approval / clarify
    // / sudo request for this connection instead of stalling.
    const readyInfo = await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no gateway.ready within 10s')), 10000)),
    ])
    console.log(`gateway.ready  ${short(readyInfo, 400)}`)

    capabilities = await request('client.capabilities', { server_requests: true, desktop_local: false })
    console.log(`client.capabilities -> ${short(capabilities, 600)}`)

    try {
      const gatewayCaps = await request('gateway.capabilities', {})
      console.log(`gateway.capabilities -> ${short(gatewayCaps, 600)}`)
    } catch (err) {
      console.log(`gateway.capabilities unavailable: ${err.message}`)
    }

    const sessions = await request('session.list', { limit: 25 })
    const rows = sessions?.sessions || []
    console.log(`\nsession.list -> ${rows.length} session(s)`)
    for (const row of rows.slice(0, 10)) {
      console.log(`  ${row.id}  live=${row.live_message_count ?? '-'}  "${row.title || '(untitled)'}"  ${short(row.preview, 60)}`)
    }

    const active = await request('session.active_list', {})
    const live = active?.sessions || []
    console.log(`\nsession.active_list -> ${live.length} live session(s)`)
    for (const row of live) {
      console.log(`  ${row.id}  status=${row.status}  "${row.title || '(untitled)'}"  msgs=${row.message_count}`)
    }

    const target = session || live[0]?.id || (activate ? rows[0]?.id : null)
    if (!target) {
      console.log('\nNo live session to attach to. Start a turn on the gateway, or pass --session <id> --activate.')
    } else {
      console.log(`\nsession.activate ${target}`)
      const attached = await request('session.activate', { session_id: target, profile: null, cols: null })
      const messages = attached?.messages || []
      console.log(`  message_count=${attached?.message_count}  running=${attached?.running}  status=${attached?.status}`)
      console.log(`  info.model=${attached?.info?.model}  info.cwd=${attached?.info?.cwd}`)
      console.log(`  transcript rows: ${messages.length}`)
      for (const row of messages.slice(-4)) {
        const text = row.text ?? row.content ?? ''
        console.log(`    [${row.role}] ${short(text, 100)}`)
      }
      if (attached?.inflight) {
        console.log('  inflight (turn history does not hold yet):')
        console.log(`    user: ${short(attached.inflight.user, 200)}`)
        console.log(`    assistant so far (${attached.inflight.assistant?.length ?? 0} chars): ${short(attached.inflight.assistant, 200)}`)
        console.log(`    streaming=${attached.inflight.streaming} status=${attached.inflight.status} error=${attached.inflight.error}`)
        if (attached.inflight.corrections?.length) {
          console.log(`    corrections: ${json(attached.inflight.corrections)}`)
        }
      } else {
        console.log('  inflight: none (session idle)')
      }
      const openRequests = attached?.open_requests || []
      console.log(`  open_requests: ${openRequests.length}`)
      for (const open of openRequests) {
        console.log(`    ${open.method} id=${open.id} ${short(open.params)}`)
        if (open.method === 'approval') {
          send({ jsonrpc: '2.0', id: open.id, result: { choice: 'deny' } })
          answered.push({ id: open.id, method: open.method, result: { choice: 'deny' } })
          console.log('    -> answered deny (replayed request)')
        }
      }
    }

    if (watchSeconds > 0) {
      console.log(`\n--- streaming for ${watchSeconds}s (Ctrl+C to stop) ---`)
      await new Promise((resolve) => setTimeout(resolve, watchSeconds * 1000))
    }

    console.log(`\n--- summary ---`)
    console.log(`events seen: ${events.length} (${[...new Set(events.map((e) => e.type))].join(', ') || 'none'})`)
    console.log(`server requests: ${serverRequests.length}, answered: ${answered.length}`)
    return { ok: true, readyPayload, capabilities, liveCount: live.length, eventCount: events.length }
  } finally {
    for (const [, record] of pending) {
      clearTimeout(record.timer)
      record.reject(new Error('probe finished'))
    }
    close()
  }
}

// --------------------------------------------------------------------- main ---

async function main() {
  let args
  try {
    args = parseArgs(process.argv)
  } catch (err) {
    console.error(err.message)
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  if (args.help) {
    console.log(USAGE)
    return
  }
  if (!args.url) {
    console.error('missing --url (or HERMES_GATEWAY_URL)')
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  // Gated gateway: sign in first. The ticket is minted after the HTTP leg so it
  // cannot expire (30 s TTL) while the status request is running.
  let cookie = ''
  if (args.user || args.password) {
    if (!args.user || !args.password) {
      console.error('--user and --password must be given together')
      process.exitCode = 1
      return
    }
    try {
      cookie = await signIn(args.url, {
        provider: args.provider,
        username: args.user,
        password: args.password,
      })
      console.log(`signed in as ${args.user} (provider ${args.provider || 'basic'})`)
    } catch (err) {
      console.error(`\nsign-in failed: ${err.message}`)
      process.exitCode = 2
      return
    }
  }

  console.log('--- HTTP leg ---')
  const headers = cookie
    ? { cookie }
    : args.token
      ? { 'X-Hermes-Session-Token': args.token }
      : {}
  const http = await probeHttp(args.url, headers)
  console.log(`GET ${http.url} -> ${http.ok ? 'OK' : 'FAIL'} status=${http.status} in ${http.ms}ms`)
  if (http.error) console.log(`  error: ${http.error}`)
  else console.log(`  body: ${short(http.body, 500)}`)

  let credential = { kind: 'token', value: args.token }
  if (cookie) {
    try {
      credential = { kind: 'ticket', value: await mintTicket(args.url, cookie) }
      console.log('minted a one-use WebSocket ticket')
    } catch (err) {
      console.error(`\nticket failed: ${err.message}`)
      process.exitCode = 2
      return
    }
  }

  let wsResult
  try {
    wsResult = await probeWs({
      baseUrl: args.url,
      credential,
      session: args.session,
      activate: args.activate,
      watchSeconds: args.watch,
    })
  } catch (err) {
    console.error('\n--- WebSocket leg FAILED ---')
    console.error(err.message)
    if (http.ok) {
      console.error(
        '\nHTTP reached the gateway but the WebSocket leg did not. That normally means a proxy,\n' +
          'firewall or the gateway auth/origin guard is blocking /api/ws. A bare "socket error\n' +
          'before open" on a gated gateway is a close before accept (HTTP 403) — the ticket was\n' +
          'refused; close 4401 = bad credential, 4403 = host/origin mismatch or chat disabled.',
      )
    }
    process.exitCode = 2
    return
  }

  console.log('\nprobe complete: both legs OK')
  if (!http.ok) console.log('note: the HTTP leg failed but the WebSocket worked (some proxies only allow /api/ws).')
  process.exitCode = wsResult.ok ? 0 : 3
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
