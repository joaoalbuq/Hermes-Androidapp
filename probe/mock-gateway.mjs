#!/usr/bin/env node
/**
 * Minimal mock Hermes gateway — a protocol fixture, not a server implementation.
 *
 * It exists so the probe and the app's client code can be exercised end to end on
 * a machine with no Hermes install. It speaks the wire format documented in
 * tui_gateway/ws.py + apps/shared/src/gateway-contract.openrpc.json:
 *
 *   - WebSocket upgrade on /api/ws, token from ?token= (rejecting "bad")
 *   - with --gated it behaves like a gated gateway: nothing but a valid one-use
 *     ?ticket= is accepted at the upgrade, refused with a bare 403 before accept
 *     (exactly what Starlette sends, and what the live gateway answered)
 *   - sends gateway.ready immediately after accept
 *   - answers client.capabilities / gateway.capabilities / session.list /
 *     session.active_list / session.activate / prompt.submit / ping
 *   - streams message.delta token by token, tool.start/complete, message.complete
 *   - raises an `approval` server->client request mid-turn and records the answer
 *
 * Usage: node probe/mock-gateway.mjs [--port 9919] [--token dev]
 *        node probe/mock-gateway.mjs --gated [--user admin] [--pass secret]
 * Then:  node probe/probe.mjs --url http://127.0.0.1:9919 --token dev --session live-1 --watch 4
 *        node probe/probe.mjs --url http://127.0.0.1:9919 --user admin --password secret
 */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const PORT = Number(argValue('--port', '9919'))
const TOKEN = argValue('--token', 'dev')
const HOST = argValue('--host', '127.0.0.1')
const GATED = argv.includes('--gated')
const USER = argValue('--user', 'admin')
const PASSWORD = argValue('--pass', 'secret')
const PROVIDER = 'basic'

/** Live tickets minted by /api/auth/ws-ticket; single-use, like the real thing. */
const tickets = new Set()
const SESSION_COOKIE = 'hermes_session=mock-session'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** Encode one unmasked server->client text frame. */
function encodeText(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** Parse a client frame; returns null until the whole frame has arrived. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < offset + 2) return null
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null
    length = Number(buffer.readBigUInt64BE(offset))
    offset += 8
  }
  let mask
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return { opcode, payload, consumed: offset + length }
}

const nowSeconds = () => Date.now() / 1000

/**
 * Stored chats, one home per profile — as the real gateway keeps them.
 *
 * A session id is only resolvable inside its own profile's store, which is why a
 * client that activates profile-B's id against the default home gets
 * 4007 "session not found".
 */
const STORED_SESSIONS = [
  {
    id: 'sess-001',
    profile: 'default',
    resolved_id: 'sess-001',
    model: 'claude-sonnet-4',
    title: 'Refactor the ingest pipeline',
    preview: 'I moved the parser into its own module and…',
    started_at: nowSeconds() - 86400,
    message_count: 24,
    source: 'desktop',
  },
  {
    id: 'sess-002',
    profile: 'ops',
    resolved_id: 'sess-002',
    model: 'gpt-5-codex',
    title: 'Tailscale + reverse proxy setup',
    preview: 'Set dashboard.public_url to the public origin…',
    started_at: nowSeconds() - 3600,
    message_count: 8,
    source: 'cli',
  },
  {
    id: 'live-1',
    profile: 'default',
    resolved_id: 'live-1',
    model: 'claude-sonnet-4',
    title: 'Nightly migration',
    preview: 'running the migration now',
    started_at: nowSeconds() - 300,
    message_count: 12,
    source: 'desktop',
  },
]

/**
 * Files the fixture can serve over /api/fs/download, addressed by the same
 * absolute paths a MEDIA: tag would carry.
 */
const MOCK_FILES = new Map([
  [
    '/srv/app/report.txt',
    {
      name: 'migration-report.txt',
      mime: 'text/plain; charset=utf-8',
      body: 'migration 0042_auth_tokens\n420 rows written\nfinished in 1.8s\n',
    },
  ],
  [
    '/srv/app/coverage.png',
    {
      name: 'coverage.png',
      mime: 'image/png',
      // 1x1 transparent PNG, enough to prove bytes survive the round trip.
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    },
  ],
])

const profileOf = (profile) => profile || 'default'
const storedFor = (idOrTitle, profile) =>
  STORED_SESSIONS.find(
    (s) => profileOf(s.profile) === profileOf(profile) && (s.id === idOrTitle || s.title === idOrTitle),
  ) || null

/** A two-turn transcript for a chat this fixture has no real history for. */
function transcriptFor(stored) {
  return [
    {
      role: 'user',
      text: `Pick up where we left off: ${stored.title.toLowerCase()}.`,
      timestamp: stored.started_at + 2,
    },
    {
      role: 'assistant',
      text: stored.preview || 'On it.',
      timestamp: stored.started_at + 4,
    },
  ]
}

function liveRow() {
  return {
    current: false,
    id: 'live-1',
    session_key: 'live-1',
    last_active: nowSeconds() - 2,
    message_count: 12,
    model: 'claude-sonnet-4',
    preview: 'running the migration now',
    title: 'Nightly migration',
    source: 'desktop',
    started_at: nowSeconds() - 300,
    status: 'working',
  }
}

const TRANSCRIPT = [
  { role: 'user', text: 'Run the migration on staging and report back.', timestamp: nowSeconds() - 290 },
  { role: 'assistant', text: 'Starting with a dry run so we can see the row counts.', timestamp: nowSeconds() - 288 },
  {
    role: 'tool',
    name: 'bash',
    args: { command: 'pnpm migrate --dry-run' },
    content: '4 tables, 1820 rows would change',
    tool_call_id: 'call-1',
    timestamp: nowSeconds() - 285,
  },
]

const INFLIGHT = {
  user: 'Run it for real this time.',
  assistant: 'Applying migration 0042_auth_tokens… ',
  streaming: true,
  status: 'working',
  corrections: [],
  error: null,
  display_kind: null,
  display_metadata: null,
}

function createSocketBridge(socket) {
  let buffer = Buffer.alloc(0)
  let closed = false

  const send = (frame) => {
    if (closed) return
    try {
      socket.write(encodeText(JSON.stringify(frame)))
    } catch {
      closed = true
    }
  }

  const sendEvent = (type, sessionId, payload) => {
    send({
      jsonrpc: '2.0',
      method: 'event',
      params: { type, ...(sessionId ? { session_id: sessionId } : {}), payload: payload ?? null },
    })
  }

  const respond = (id, result) => send({ jsonrpc: '2.0', id, result })
  const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  const timers = new Set()
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
  }

  const close = () => {
    if (closed) return
    closed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    try {
      socket.end()
    } catch {
      /* ignore */
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const frame = decodeFrame(buffer)
      if (!frame) break
      buffer = buffer.subarray(frame.consumed)
      if (frame.opcode === 0x8) {
        close()
        return
      }
      if (frame.opcode === 0x9) {
        // ping -> pong (opcode 0xa), unmasked
        const payload = frame.payload
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]))
        continue
      }
      if (frame.opcode !== 0x1) continue
      let request
      try {
        request = JSON.parse(frame.payload.toString('utf8'))
      } catch {
        respondError(null, -32700, 'parse error')
        continue
      }
      handle(request)
    }
  })

  socket.on('close', close)
  socket.on('error', close)

  let approved = false
  let runtimeSeq = 0
  /** runtime handle -> stored chat, the two-id model session.resume introduces. */
  const runtimeToStored = new Map()

  function snapshot(stored, runtimeId) {
    const live = stored.id === 'live-1'
    return {
      session_id: runtimeId,
      stored_session_id: stored.id,
      resumed: live ? stored.id : null,
      session_key: stored.id,
      message_count: live ? TRANSCRIPT.length : 2,
      messages: live ? TRANSCRIPT : transcriptFor(stored),
      info: {
        model: stored.model,
        provider: 'anthropic',
        cwd: '/srv/app',
        title: stored.title,
        running: live,
        turn_started_at: live ? nowSeconds() - 12 : null,
        stored_session_id: stored.id,
      },
      running: live,
      status: live ? 'working' : 'idle',
      ...(live
        ? {
            turn_started_at: nowSeconds() - 12,
            inflight: INFLIGHT,
            open_requests: [
              {
                id: 'srq-open-1',
                method: 'approval',
                params: {
                  session_id: runtimeId,
                  request_id: 'req-open-1',
                  command: 'pnpm migrate --apply',
                  description: 'Apply migration 0042 to staging',
                  choices: ['once', 'session', 'always', 'deny'],
                },
              },
            ],
          }
        : {}),
    }
  }

  function handle(request) {
    // A response to one of OUR server->client requests.
    if (request.id !== undefined && request.method === undefined) {
      console.log(`[mock] got answer to server request ${request.id}: ${JSON.stringify(request.result ?? request.error)}`)
      approved = true
      return
    }

    const { id, method, params } = request
    console.log(`[mock] <- ${method} ${JSON.stringify(params ?? {})}`)

    switch (method) {
      case 'client.capabilities': {
        respond(id, {
          server_requests: ['approval', 'clarify', 'sudo', 'secret', 'vault.code', 'vault.unlock_prompt'],
          declines_not_shown: false,
          canonical_clarify_batch: false,
        })
        return
      }
      case 'gateway.capabilities':
        respond(id, { canonical_messages: true, event_replay: true, inflight: true })
        return
      case 'ping':
      case 'gateway.ping':
        respond(id, { ok: true })
        return
      case 'session.list':
        // Profile-scoped, like the real handler: the default home does not see
        // another bot's chats.
        respond(id, {
          sessions: STORED_SESSIONS.filter((s) => profileOf(s.profile) === profileOf(params?.profile)),
        })
        return
      case 'session.active_list':
        // Live sessions are profile-scoped too; the default home owns live-1.
        respond(id, {
          sessions: profileOf(params?.profile) === 'default' ? [liveRow()] : [],
        })
        return
      case 'profiles.list':
        // Whole roster, as the real handler returns it — each bot carries the
        // session the desktop app would have been in last.
        respond(id, {
          profiles: [
            {
              name: 'default',
              path: '/home/hermes',
              is_default: true,
              model: 'claude-sonnet-4',
              provider: 'anthropic',
              display_name: 'Main',
              description: 'general assistant',
              skill_count: 12,
              // The durable id lives under `id` — `session_id` does not exist here.
              last_session: {
                id: 'live-1',
                title: 'Nightly migration',
                preview: 'running the migration now',
                started_at: nowSeconds() - 300,
                last_active: nowSeconds() - 2,
                message_count: 12,
              },
            },
            {
              name: 'ops',
              path: '/home/hermes/profiles/ops',
              is_default: false,
              model: 'gpt-5-codex',
              provider: 'openai',
              display_name: 'Ops bot',
              description: 'infra and deploys',
              skill_count: 4,
              last_session: {
                id: 'sess-002',
                title: 'Tailscale + reverse proxy setup',
                preview: 'Set dashboard.public_url to the public origin…',
                started_at: nowSeconds() - 3600,
                last_active: nowSeconds() - 1800,
                message_count: 8,
              },
            },
            {
              name: 'writer',
              path: '/home/hermes/profiles/writer',
              is_default: false,
              model: 'claude-haiku',
              provider: 'anthropic',
              display_name: 'Docs bot',
              description: 'changelogs and docs',
              skill_count: 2,
              last_session: null,
            },
          ],
          bot_mode_protocol: true,
          install_id: 'mock-install',
        })
        return
      case 'session.resume': {
        const stored = storedFor(params?.session_id, params?.profile)
        if (!stored) {
          respondError(id, 4007, 'session not found')
          return
        }
        // A runtime handle is minted per attach; it is what events address.
        runtimeSeq += 1
        const runtimeId = `rt-${runtimeSeq}`
        runtimeToStored.set(runtimeId, stored)
        respond(id, snapshot(stored, runtimeId))
        if (stored.id === 'live-1') streamTurn(runtimeId)
        return
      }
      case 'session.activate': {
        // Only a session that is already live here can be activated.
        const stored = storedFor(params?.session_id, params?.profile)
        if (!stored || stored.id !== 'live-1') {
          respondError(id, 4007, stored ? 'session is no longer live' : 'session not found')
          return
        }
        runtimeSeq += 1
        const runtimeId = `rt-${runtimeSeq}`
        runtimeToStored.set(runtimeId, stored)
        respond(id, snapshot(stored, runtimeId))
        streamTurn(runtimeId)
        return
      }
      case 'file.attach': {
        // The legacy wire has no attachments field on prompt.submit: a file is
        // staged here and the prompt then carries the returned @file: ref.
        const name = String(params?.name || 'upload.bin')
        const safe = name.replace(/[^\w.\-]+/g, '_')
        const refPath = `uploads/web-${randomUUID().slice(0, 8)}-${safe}`
        const size = params?.data_url ? Buffer.byteLength(String(params.data_url), 'utf8') : 0
        console.log(`[mock] staged file ${name} via ${params?.data_url ? 'data_url' : 'path'} (${size} b64 chars)`)
        respond(id, {
          attached: true,
          name,
          path: `/srv/app/${refPath}`,
          ref_path: refPath,
          ref_text: `@file:${refPath}`,
          uploaded: true,
        })
        return
      }
      case 'image.attach_bytes': {
        const name = String(params?.filename || 'image.png')
        const bytes = params?.content_base64
          ? Buffer.from(String(params.content_base64), 'base64').length
          : 0
        console.log(`[mock] staged image ${name} (${bytes} bytes decoded)`)
        respond(id, {
          attached: true,
          name,
          path: `/srv/app/uploads/${name}`,
          mime: 'image/png',
          bytes,
        })
        return
      }
      case 'prompt.submit': {
        const stored = runtimeToStored.get(params?.session_id)
        if (!stored) {
          respondError(id, 4007, 'session not found')
          return
        }
        respond(id, { ok: true })
        streamTurn(params.session_id)
        return
      }
      case 'session.interrupt':
        respond(id, { ok: true })
        return
      default:
        respondError(id, -32601, `mock gateway does not implement ${method}`)
    }
  }

  let streaming = false

  function streamTurn(sessionId) {
    if (streaming) return
    streaming = true
    const chunks = ['Applying ', 'migration ', '0042_auth_tokens', '… ', '420 rows ', 'written.']
    let index = 0
    sendEvent('message.start', sessionId, {})
    const tick = () => {
      sendEvent('message.delta', sessionId, { text: chunks[index] })
      index += 1
      if (index < chunks.length) {
        later(tick, 120)
        return
      }
      later(() => {
        sendEvent('tool.start', sessionId, {
          tool_id: 'tool-9',
          name: 'bash',
          args: { command: 'pnpm migrate --apply' },
          preview: 'pnpm migrate --apply',
        })
        later(() => {
          sendEvent('tool.complete', sessionId, {
            tool_id: 'tool-9',
            name: 'bash',
            duration_s: 1.8,
            summary: 'migration applied',
            result_text: '0042_auth_tokens applied\n420 rows written',
          })
          // A question the agent asks while we watch, from a fresh request id.
          send({
            jsonrpc: '2.0',
            id: 'srq-live-2',
            method: 'approval',
            params: {
              session_id: sessionId,
              request_id: 'req-live-2',
              command: 'git commit -am "migration 0042"',
              description: 'Commit the migration?',
              choices: ['once', 'session', 'always', 'deny'],
            },
          })
          later(() => {
            sendEvent('message.complete', sessionId, {
              // A delivered file rides in the prose as a MEDIA tag, exactly as the
              // agent emits it; the client turns that into a download chip.
              text: `${chunks.join('')} Report: MEDIA:/srv/app/report.txt`,
              
              status: 'completed',
              usage: { input_tokens: 1200, output_tokens: 340 },
            })
            streaming = false
          }, 1200)
        }, 900)
      }, 300)
    }
    later(tick, 120)
  }

  sendEvent('gateway.ready', null, { skin: null, change_events: true, heartbeat: true, replay_epoch: 1 })
  return { close }
}

const server = createServer((req, res) => {
  const path = (req.url || '').split('?')[0]
  // Permissive CORS so the app can be exercised in a desktop browser during
  // development; a real gateway only trusts its own dashboard origins.
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('vary', 'Origin')
    // The download helper reads the server's filename out of this header.
    res.setHeader('access-control-expose-headers', 'content-disposition, content-length, content-type')
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-headers', 'content-type, x-hermes-session-token')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.writeHead(204)
    res.end()
    return
  }
  const cookie = String(req.headers.cookie || '')
  const signedIn = GATED ? cookie.includes(SESSION_COOKIE.split('=')[0]) : true

  if (GATED && path === '/auth/password-login' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        /* invalid */
      }
      if (!parsed.provider) {
        res.writeHead(422, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ detail: [{ loc: ['body', 'provider'], msg: 'Field required' }] }))
        return
      }
      if (parsed.username !== USER || parsed.password !== PASSWORD) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ detail: 'Invalid credentials' }))
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
      })
      res.end(JSON.stringify({ ok: true, username: USER }))
    })
    return
  }

  if (GATED && path === '/api/auth/ws-ticket' && req.method === 'POST') {
    if (!signedIn) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthenticated', reason: 'no_cookie' }))
      return
    }
    const ticket = `tk-${randomUUID().slice(0, 8)}`
    tickets.add(ticket)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ticket, expires_in: 30 }))
    return
  }

  if (path.startsWith('/api/status')) {
    const auth = req.headers['x-hermes-session-token']
    const authorized = GATED ? signedIn : auth === TOKEN
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        version: 'mock-0.0.1',
        profiles: [{ name: 'default', running: true }],
        uptime_s: Math.round(process.uptime()),
      }),
    )
    return
  }
  // File downloads: cookie-authenticated REST, as a gated gateway serves them.
  if ((path === '/api/fs/download' || path === '/api/files/download') && req.method === 'GET') {
    if (!signedIn) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthenticated', detail: 'Unauthorized' }))
      return
    }
    const params = new URL(req.url || '/', 'http://localhost').searchParams
    const file = MOCK_FILES.get(params.get('path') || '')
    if (!file) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    const bytes = file.base64 ? Buffer.from(file.base64, 'base64') : Buffer.from(file.body, 'utf8')
    console.log(`[mock] download ${params.get('path')} -> ${file.name} (${bytes.length} bytes)`)
    res.writeHead(200, {
      'content-type': file.mime,
      'content-length': bytes.length,
      'content-disposition': `attachment; filename="${file.name}"`,
    })
    res.end(bytes)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (!url.pathname.endsWith('/api/ws')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  if (GATED) {
    // Gated mode accepts nothing but a fresh ticket, and refuses before accept:
    // the client sees HTTP 403 and an abnormal close with no reason.
    const ticket = url.searchParams.get('ticket')
    if (!ticket || !tickets.has(ticket)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    tickets.delete(ticket)
  } else {
    const token = url.searchParams.get('token')
    if (token !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
  }
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(String(key))}\r\n\r\n`,
  )
  console.log(`[mock] ws accepted from ${socket.remoteAddress} ${url.pathname}`)
  createSocketBridge(socket)
})

server.listen(PORT, HOST, () => {
  console.log(`[mock] Hermes gateway fixture on http://${HOST}:${PORT}  (token: ${TOKEN})`)
  if (GATED) {
    console.log(`[mock]   gated mode: sign-in ${USER}/****** via POST /auth/password-login`)
    console.log(`[mock]   ws://${HOST}:${PORT}/api/ws?ticket=<one-use>`)
  } else {
    console.log(`[mock]   ws://${HOST}:${PORT}/api/ws?token=${TOKEN}`)
  }
})
