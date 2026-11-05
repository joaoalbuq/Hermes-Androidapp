# Hermes Mobile

A phone-sized **viewer** for a Hermes gateway you already run. It connects over the same
JSON-RPC WebSocket the Desktop app speaks, discovers your sessions and bots, and — the point of
the whole thing — **attaches to a turn that is already running** so you can follow it and answer
the questions the agent asks, from the phone.

It is a client. It does not create bots or profiles, does not configure the gateway, and installs
nothing server-side. The only setup is a gateway URL and a token.

---

## Get it without building

A built debug APK is attached to the GitHub release:

<https://github.com/joaoalbuq/Hermes-Androidapp/releases/download/v1.4.2/hermes-mobile-1.4.2-debug.apk>

Repo: <https://github.com/joaoalbuq/Hermes-Androidapp>

## Build the APK

Prerequisites on the build machine: **Node 20+**, **JDK 21**, **Android SDK** (platform 36,
build-tools), and `ANDROID_HOME` set. This repo was authored on a machine *without* a JDK, so the
APK itself has not been compiled here — see [Verification](#verification).

```bash
npm install
npm run build            # tsc + vite -> dist/
npx cap sync android     # copies dist/ and native plugins into android/
cd android
./gradlew assembleDebug  # Windows: gradlew.bat assembleDebug
```

Output:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Identity of this build (read from the native project, `android/app/build.gradle`):

| | |
|---|---|
| `applicationId` | `com.hermesmobile.viewer` |
| `versionCode` | `1` |
| `versionName` | `1.0` |
| `minSdkVersion` | 24 |
| `compileSdkVersion` | 36 |

**Uninstall any previous build first.** Debug APKs are re-signed with a fresh debug key on a new
machine; Android then refuses the install with a bare "App not installed" instead of an upgrade.

Bump `versionCode` in `android/app/build.gradle` for every build you side-load.

For a release build, create a keystore and sign it — `assembleDebug` is for personal use and its
signature is not stable across machines.

---

## Connect it

Settings → **Add connection**: a name, the gateway base URL, and how it authenticates. There are
three modes, and picking the wrong one is the single most likely reason a connection never opens.

A new connection comes **prefilled with this build's gateway**
(`https://hermes-agent-whz6.srv2007716.hstgr.cloud`, name "Hermes online") and with password mode
selected, so on the phone you type only your username and password — once. The URL lives in
`src/config.ts`; any other gateway can still be added from Settings.

| Your gateway | Mode |
|---|---|
| Anything with a sign-in page (`auth_required: true`) | **Username & password** (default — stays signed in) |
| `hermes serve` on loopback, or `--insecure` (no sign-in page, `auth_required: false`) | **Session token** |
| Any provider, if you would rather no password be stored | **Gateway sign-in** (optional) |

To tell them apart, `GET <base>/api/health` returns `{"ok":true,…,"auth_required":true|false}`.
A gated gateway also redirects `/` to `/login` and lists its providers at `/api/auth/providers`.

**Session token mode.** The token rides `?token=` on the WebSocket.

**Username & password mode (default).** The app signs in itself at `POST /auth/password-login`
(`{provider, username, password}`), keeps the password in the Android Keystore, and signs in
silently on every launch — open the app and you are in. When the session expires mid-use it
re-signs in once by itself. This is the least-friction mode, so it is what a new connection starts
with.

**Gateway sign-in mode (optional).** The app opens your gateway's own `/login` page in an in-app
WebView and you type your username and password *there*, so no password is ever stored — only the
resulting session cookie, exchanged for a one-use ticket before each dial. Because the login page
is the gateway's, it survives a provider change (e.g. if you later enable an OAuth portal). The
cost is friction: you sign in again whenever the session expires.

Either signed-in mode then exchanges the cookie for a one-use ticket at
`POST /api/auth/ws-ticket` — the only credential a gated gateway's WebSocket accepts (see the
protocol notes). The ticket is minted fresh on every reconnect because it lives 30 seconds and is
single-use.

- Base URL is the backend root, e.g. `http://homelab.lan:9119` or `https://gw.example.com/hermes`.
  Reverse-proxy path prefixes work — the app appends `/api/ws` and `/api/status` to whatever path
  you give it.
- The gateway must actually be reachable from the phone. A `hermes serve` bound to loopback is not:
  bind it to the LAN interface or put it behind Tailscale / a TLS proxy.
- **Use `https://` / `wss://` if at all possible.** The WebSocket credential has to ride in the URL
  query string (see the protocol notes), and query strings end up in proxy access logs.

Tap **Test** and read both legs:

```
HTTP:      reachable, credentials accepted
WebSocket: open, gateway.ready received
```

They are reported separately on purpose. HTTP passing while the WebSocket fails almost always
means a proxy, firewall, or the gateway's auth/Origin guard is refusing `/api/ws`
(close code `4401` = credential refused, `4403` = host/origin mismatch or chat disabled).

---

## What it does

- **Sessions** — `session.list` (saved transcripts) merged with `session.active_list` (live in the
  gateway process), with live status, unread counts, and a search box.
- **Bots** — the profile roster from `profiles.list`. Selecting one scopes discovery to that profile.
- **Attach to a running turn** — `session.resume` (falling back to `session.activate` on older
  builds) returns `inflight` (the turn history does not hold yet) and `open_requests` (questions
  still awaiting an answer). Both are re-rendered on attach, so you land mid-turn exactly where the
  gateway is, whether or not the chat was live when the app opened.
- **Sending files** — 📎 in the composer stages a picked file with `image.attach_bytes` (images) or
  `file.attach` (anything else) and sends the returned `@file:` reference with the next prompt,
  since `prompt.submit` has no attachments field on this wire.
- **Pulling files down** — a `MEDIA:/path` tag in the agent's reply becomes a ⬇ chip; tapping it
  downloads the file through `/api/fs/download` (cookie-authenticated) and writes it into the
  phone's Downloads folder via a small native MediaStore plugin.
- **Staying connected while locked** — a native foreground service with a partial wake lock keeps
  the WebView's event loop (and the socket on it) running with the screen off, so a turn that
  finishes in the background lands in the chat and shows up as unread. On every resume the client
  re-dials instead of trusting a socket that reports `OPEN` and answers nothing, then re-attaches
  the open chat and reloads its transcript.
- **One chat per bot** — the drawer collapses to the chat you are in, each bot's synced chat, and
  anything live; older chats are one tap away. Discovery is the authority: chats from another bot
  and ghost entries left by dead runtime handles are dropped instead of piling up as duplicates.
- **Model & reasoning picker** — a pill above the composer opens the gateway's `model.options`
  inventory with per-model capability hints. A pick runs `/model` on the open chat through
  `command.dispatch` (the documented mid-session switch — there is no `session.set_model`), or
  persists the choice on the bot with `config.set`; reasoning levels use `/reasoning` with the same
  two scopes, and an expensive model is confirmed before it is written.
- **Background notifications** — while the app is not on screen, a turn finishing or the agent
  asking a question raises a notification (its own high-importance channel, Android 13+ permission
  requested on connect) instead of waiting silently.
- **Computer panel** — a third drawer tab shows the machine running the gateway from its own
  `/api/status` (version, uptime, which bots are running, reachability), plus *Wake & re-sync*, which
  redials and re-reads the host, and the background-connection state with the one Android setting
  that keeps the link alive through a long lock.
- **Live streaming** — `message.delta` token by token, `tool.start` / `tool.complete` as live tool
  activity (never raw JSON), plus `message.complete`, `session.title`, `session.info`, `error`.
- **Answering the agent** — `approval`, `clarify`, `sudo`, `secret`, `vault.code`,
  `vault.unlock_prompt` are answered as JSON-RPC responses bearing the same id. Anything else the
  gateway asks (`terminal.read`, `window.read`, `preview.act`, `tour`, `connection`, …) is refused
  with `-32601` so the agent fails fast instead of waiting out a timeout.
- **Steering** — while a turn runs, the composer sends `session.steer` instead of
  `prompt.submit`, so a phone message corrects the live turn rather than queueing behind it.
- **Scroll-follow** — a chat you left at the bottom keeps following new output; scroll up and it
  holds your position until you tap "Jump to latest".
- **Multiple saved connections** — one is active at a time.

### Deliberately dropped from v1

- Creating or editing bots/profiles.
- Message rewind / edit-and-regenerate (`truncate_before_row_id`, `confirm_deep_truncate`, row-id
  rebinding) — left out cleanly rather than half-built.
- Server-side installs, gateway config, plugin/MCP management.
- OAuth / Nous Portal sign-in: token auth only.
- Voice input / dictation. (File and image attachments arrived in 1.2.)
- All connections connected concurrently (Desktop keeps every gateway dialled; this app keeps the
  active one connected and remembers the rest).
- Server-side full-text search: search covers discovered sessions and messages already loaded.

---

## Protocol notes — where the brief and the source disagreed

The brief said the source wins. These are the differences found by reading
`tui_gateway/server.py`, `tui_gateway/ws.py`, `hermes_cli/web_server_chat.py`,
`hermes_cli/web_server_boundary.py`, and the generated contract
`apps/shared/src/gateway-contract.openrpc.json`:

1. **The WebSocket does not take `X-Hermes-Session-Token`.** That header authenticates the *REST*
   leg (`GET /api/status`). The `/api/ws` upgrade reads its credential from `?token=` —
   loopback/`--insecure` mode compares it to the dashboard session token; gated mode verifies it as
   a user access token, or takes a one-use `?ticket=`. So the app sends the token in the query
   string and deliberately never logs the URL with it.
2. **A bot roster endpoint does exist.** `profiles.list` is one of 258 methods in the contract
   (`ProfilesListResult.profiles[]`), so the roster is discovered properly rather than seeded from
   a single call.
3. **There is an Origin gate on the WebSocket.** An `http(s)` Origin must name the exact
   host:port being dialled, so a WebView on the default `https://localhost` would be closed with
   `origin_mismatch`. A non-web scheme is trusted outright, so `capacitor.config.ts` sets
   `androidScheme: 'capacitor'` and the app runs on `capacitor://localhost`.
4. **`client.capabilities` is mandatory**, exactly as the brief says: it is sent immediately after
   `gateway.ready`, before any discovery. Without it the gateway fails every approval/clarify/sudo
   request for that connection.
5. **Per-(connection, profile) sockets** are not used. One socket is dialled per connection, and
   profile scoping is done with the `profile` parameter that `session.list`,
   `session.active_list`, `session.activate`, `session.create`, and `prompt.submit` all accept.
6. **A gated gateway rejects every static token — including with a correct one.** Verified against
   a live hosted deployment (`auth_required: true`, provider `basic`): the `/api/ws` upgrade
   answered **HTTP 403 with an empty body** for no credential, `?token=…` and `?ticket=…` alike.
   That 403 is Starlette closing the socket *before* `accept()`, so the informative `4401` reason
   never reaches the client — a WebSocket client just sees an abnormal close (1006). In gated mode
   `_ws_auth_reason` takes only a fresh ticket (`POST /api/auth/ws-ticket`), the process-internal
   credential, or an access token a *native* sign-in minted; a password-provider gateway offers no
   such sign-in, so the ticket is the only path. Hence the username/password mode above, and hence
   the client's hint when it sees a 1006.

### Two ids per chat, and which verb to attach with

A chat has a **durable/stored id** and, once attached, a **runtime id** minted for that attach
(`SessionAttachResult.session_id`, with the durable one echoed as `stored_session_id`). Events and
`prompt.submit` address the runtime handle; lists, the roster and anything remembered across
launches must use the durable id, because a runtime handle dies with the socket.

Attaching a stored chat is `session.resume` — it reuses a live run or rebuilds a cold chat and
returns `inflight` plus the still-open `open_requests`, which is what makes answering an approval
issued on another device work. `session.activate` only attaches to a chat that is already live
here, and newer gateways do not serve it at all, so the client tries `resume` and falls back.

`profiles.list` returns each bot's chats as `last_session` / `canonical_session` / `worker_session`
objects whose id is `id` (not `session_id`). Reading the wrong key silently sent the roster down a
fallback path and produced `session not found`; the roster in `probe/mock-gateway.mjs` now mirrors
the real shapes (per-profile homes, 4007 for an id from another profile) so that stays tested.

---

## The probe (run this against the real gateway first)

`probe/probe.mjs` is the CLI from step 1 of the brief, and it is what the app's client code was
built on:

```bash
# local / --insecure gateway
node probe/probe.mjs --url http://homelab.lan:9119 --token <token>

# gated gateway (auth_required): sign in, mint a ticket, dial
node probe/probe.mjs --url https://gw.example.com --user <name> --password <pass>
```

For the gated form it signs in, mints a one-use ticket, dials `/api/ws?ticket=…`, and prints which
of the three steps failed. Credentials are never echoed: the dialled URL is shown redacted.

It probes the HTTP leg, dials the WebSocket, completes `gateway.ready` → `client.capabilities`,
calls `session.list` and `session.active_list`, attaches with `session.activate`, and prints the
transcript tail plus the `inflight` turn and any `open_requests`. `--watch 30` keeps streaming
events; `--session <id> --activate` forces a specific chat.

Exit codes: `0` both legs OK, `2` transport failed, `3` protocol failed.

`probe/mock-gateway.mjs` is a protocol fixture (hand-written RFC 6455, no dependencies) that stands
in for a gateway when you have none handy. `--gated` makes it behave like a hosted deployment:
password sign-in, one-use tickets, and a bare 403 for anything else at the upgrade.

```bash
node probe/mock-gateway.mjs --port 9919 --token dev
node probe/probe.mjs --url http://127.0.0.1:9919 --token dev --session live-1 --watch 5

node probe/mock-gateway.mjs --port 9920 --gated --user admin --pass secret
node probe/probe.mjs --url http://127.0.0.1:9920 --user admin --password secret --session live-1
```

---

## Verification

What was actually run on this machine:

- `npx tsc --noEmit` and `npm run build` — clean.
- **Against a live gated gateway** (`hermes-agent-whz6.srv2007716.hstgr.cloud`, Hermes 0.22.5):
  `/api/health` reports `auth_required: true`; the provider list is `basic`; `/auth/password-login`
  takes `{provider, username, password}` and answers `401 {"detail":"Invalid credentials"}` to a
  wrong one; `/api/ws` answers **403 with an empty body** to no credential, `?token=` and
  `?ticket=` alike. That last measurement is what drove the sign-in mode.
- The gated fixture end to end: sign-in → ticket → upgrade → `gateway.ready` → capabilities →
  discovery → `session.activate` with `inflight` and a replayed `open_requests`, approvals answered
  mid-turn.
- The app in a browser against the gated fixture: saved a username/password connection, connected
  (status `connected`), listed live + stored sessions. Then the fixture was killed and restarted
  with an empty ticket store — the app reconnected on its own, which only works if a fresh ticket
  is minted per dial rather than cached.
- `probe/probe.mjs` against `probe/mock-gateway.mjs` — handshake, capabilities, discovery,
  `session.activate` with `inflight` rebuilt, replayed `open_requests`, token-by-token deltas,
  tool start/complete, a mid-turn approval raised and answered, `message.complete`.
- The web bundle in a browser against the same fixture: saved a connection, connected, listed
  sessions (live + stored), attached to a live session, saw the partial turn rendered, answered two
  approvals (one from `open_requests`, one live), sent a prompt and watched the reply stream in.

What was **not** verified:

- **The APK was never compiled or installed** — there is no JDK, Android SDK, or Gradle on this
  machine. Everything downstream of `npm run build` is untested here.
- **The browser sign-in path is unexercised on a device.** The login screen, the mode picker, the
  "no session → ask for sign-in" transition and the graceful refusal in a desktop browser were all
  driven in the browser, and the cookie→ticket half was proven with the probe against the gated
  fixture. What has never run is `openInWebView` on Android, and in particular whether
  `CapacitorCookies.getCookies` returns the gateway's (likely HttpOnly) session cookie. If it does
  not, the app says so plainly and **Username & password** mode is the fallback — that is why both
  exist.
- **No authenticated session was ever opened on a real gateway.** The live deployment was mapped
  as far as its auth surface allows without credentials (health, providers, login contract, and
  the 403 at the upgrade), but a valid sign-in was never performed, so the ticket response shape
  and everything after the upgrade were exercised against the fixture only. `mintTicket` accepts
  `ticket` / `ws_ticket` / `token` / a URL containing `ticket=` precisely because that shape is
  unconfirmed.
- Scroll-follow, unread counts, and the Bots tab were reviewed in code and the Bots empty state was
  exercised; the roster itself was never populated by a real `profiles.list`.

---

## Security notes

- In **Gateway sign-in** mode nothing but a session cookie is stored, and the password never
  reaches the app. The WebView is opened with `isIsolated: false` (`@capacitor/inappbrowser`),
  which is what lets the app read the cookie the login page set — the trade-off is that the login
  page shares the app's WebView storage instead of running in the plugin's isolated process. It is
  your own gateway, but note the trade-off if you ever point it at someone else's.
- Session tokens **and** gateway passwords are written with
  `@aparajita/capacitor-secure-storage` (Android EncryptedSharedPreferences, Android
  Keystore-backed). In a desktop browser the plugin degrades to a plain store and Settings shows a
  "plain fallback" warning for that connection.
- A password is only ever sent to `<base>/auth/password-login` over the connection's scheme, so a
  plain-`http://` gateway exposes it on the wire. Use TLS for any gateway you sign in to.
- Sign-in happens over CapacitorHttp (the platform HTTP stack) rather than `fetch`, because the
  gateway's CORS allowlist names its own dashboard origins and `capacitor://localhost` is not one
  of them. Nothing about the sign-in leaves the app except those two HTTPS requests.
- The token is never logged, never put in the bundle, never baked into the build. The gateway URL is
  runtime configuration on the Settings screen (`capacitor.config.ts` deliberately has no
  `server.url`).
- Android backups are disabled (`android:allowBackup="false"`) so app data is not swept into a
  cloud backup.
- `android:usesCleartextTraffic="true"` is set so plain-`http://` LAN gateways work. Tighten it to
  `false` and a network-security-config allowlist if you only ever use TLS.
