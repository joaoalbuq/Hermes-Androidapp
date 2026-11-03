import { Preferences } from '@capacitor/preferences'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'

/**
 * Connections live in Preferences (names, URLs — non-secret).
 * Session tokens live in encrypted storage: on Android the plugin uses
 * EncryptedSharedPreferences backed by the Android Keystore, so the token is not
 * readable from a plain app-data dump. If the native plugin is unavailable (e.g.
 * `npm run dev` in a desktop browser), tokens fall back to Preferences and
 * `insecureTokenFallback()` reports it so Settings can warn.
 */

export interface SavedConnection {
  id: string
  name: string
  baseUrl: string
  /**
   * How the gateway authenticates this client.
   *  - `token`    : loopback / --insecure gateway; the dashboard session token
   *                 rides `?token=` on the WebSocket.
   *  - `password` : gated gateway with a password provider; the app signs in,
   *                 then mints a one-use ticket per dial. See protocol/auth.ts.
   * Absent on connections saved before this existed — treated as `token`.
   */
  authMode?: 'token' | 'password' | 'signin'
  /** Username for `password` mode. Not a secret. */
  username?: string
  /** Dashboard auth provider for `password` mode (`basic` = username & password). */
  provider?: string
  /** Last known token mode, shown in Settings. */
  lastStatus?: 'ok' | 'auth_failed' | 'unreachable'
}

const CONNECTIONS_KEY = 'hermes.connections'
const ACTIVE_KEY = 'hermes.activeConnection'
const tokenKey = (id: string) => `hermes.token.${id}`
const tokenModeKey = (id: string) => `hermes.tokenMode.${id}`
const passwordKey = (id: string) => `hermes.password.${id}`
const passwordModeKey = (id: string) => `hermes.passwordMode.${id}`
const cookieKey = (id: string) => `hermes.cookie.${id}`
const cookieModeKey = (id: string) => `hermes.cookieMode.${id}`

/** Last chat opened per (connection, profile) — this is what makes the app resume. */
const lastSessionKey = (id: string, profile: string | null) =>
  `hermes.lastSession.${id}.${profile ? encodeURIComponent(profile) : '_'}`

/** Which bot was selected, so a relaunch comes back to the same one. */
const profileKey = (id: string) => `hermes.profile.${id}`

let insecureFallback = false

export function insecureTokenFallback(): boolean {
  return insecureFallback
}

export function newConnectionId(): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `conn-${Date.now().toString(36)}-${random}`
}

export async function loadConnections(): Promise<SavedConnection[]> {
  const { value } = await Preferences.get({ key: CONNECTIONS_KEY })
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as SavedConnection[]
    return Array.isArray(parsed) ? parsed.filter((c) => c && c.id && c.baseUrl) : []
  } catch {
    return []
  }
}

export async function saveConnections(connections: SavedConnection[]): Promise<void> {
  await Preferences.set({ key: CONNECTIONS_KEY, value: JSON.stringify(connections) })
}

export async function loadActiveConnectionId(): Promise<string | null> {
  const { value } = await Preferences.get({ key: ACTIVE_KEY })
  return value || null
}

export async function saveActiveConnectionId(id: string | null): Promise<void> {
  if (id) await Preferences.set({ key: ACTIVE_KEY, value: id })
  else await Preferences.remove({ key: ACTIVE_KEY })
}

export async function loadToken(id: string): Promise<string> {
  try {
    const value = await SecureStorage.get(tokenKey(id))
    if (typeof value === 'string' && value) {
      await Preferences.set({ key: tokenModeKey(id), value: 'secure' })
      return value
    }
    if (value && typeof value === 'object') return JSON.stringify(value)
  } catch (err) {
    insecureFallback = true
    console.warn('secure storage unavailable, falling back to Preferences', err)
  }
  const { value } = await Preferences.get({ key: tokenKey(id) })
  return value || ''
}

export async function saveToken(id: string, token: string): Promise<void> {
  if (!token) {
    await removeToken(id)
    return
  }
  try {
    await SecureStorage.set(tokenKey(id), token)
    await Preferences.set({ key: tokenModeKey(id), value: 'secure' })
    return
  } catch (err) {
    insecureFallback = true
    console.warn('secure storage write failed, falling back to Preferences', err)
  }
  await Preferences.set({ key: tokenKey(id), value: token })
  await Preferences.set({ key: tokenModeKey(id), value: 'plain' })
}

export async function removeToken(id: string): Promise<void> {
  try {
    await SecureStorage.remove(tokenKey(id))
  } catch {
    /* not present / unavailable */
  }
  await Preferences.remove({ key: tokenKey(id) })
  await Preferences.remove({ key: tokenModeKey(id) })
}

export async function tokenMode(id: string): Promise<'secure' | 'plain' | 'none'> {
  const { value } = await Preferences.get({ key: tokenModeKey(id) })
  if (value === 'secure') return 'secure'
  if (value === 'plain') return 'plain'
  return 'none'
}

/** Password for `password` mode — same encrypted store as the token. */
export async function loadPassword(id: string): Promise<string> {
  try {
    const value = await SecureStorage.get(passwordKey(id))
    if (typeof value === 'string' && value) {
      await Preferences.set({ key: passwordModeKey(id), value: 'secure' })
      return value
    }
  } catch (err) {
    insecureFallback = true
    console.warn('secure storage unavailable, falling back to Preferences', err)
  }
  const { value } = await Preferences.get({ key: passwordKey(id) })
  return value || ''
}

export async function savePassword(id: string, password: string): Promise<void> {
  if (!password) {
    await removePassword(id)
    return
  }
  try {
    await SecureStorage.set(passwordKey(id), password)
    await Preferences.set({ key: passwordModeKey(id), value: 'secure' })
    return
  } catch (err) {
    insecureFallback = true
    console.warn('secure storage write failed, falling back to Preferences', err)
  }
  await Preferences.set({ key: passwordKey(id), value: password })
  await Preferences.set({ key: passwordModeKey(id), value: 'plain' })
}

export async function removePassword(id: string): Promise<void> {
  try {
    await SecureStorage.remove(passwordKey(id))
  } catch {
    /* not present / unavailable */
  }
  await Preferences.remove({ key: passwordKey(id) })
  await Preferences.remove({ key: passwordModeKey(id) })
}

export async function passwordMode(id: string): Promise<'secure' | 'plain' | 'none'> {
  const { value } = await Preferences.get({ key: passwordModeKey(id) })
  if (value === 'secure') return 'secure'
  if (value === 'plain') return 'plain'
  return 'none'
}

/** Session cookie harvested from an in-app sign-in (see protocol/auth.ts). */
export async function loadCookie(id: string): Promise<string> {
  try {
    const value = await SecureStorage.get(cookieKey(id))
    if (typeof value === 'string' && value) {
      await Preferences.set({ key: cookieModeKey(id), value: 'secure' })
      return value
    }
  } catch (err) {
    insecureFallback = true
    console.warn('secure storage unavailable, falling back to Preferences', err)
  }
  const { value } = await Preferences.get({ key: cookieKey(id) })
  return value || ''
}

export async function saveCookie(id: string, cookie: string): Promise<void> {
  if (!cookie) {
    await removeCookie(id)
    return
  }
  try {
    await SecureStorage.set(cookieKey(id), cookie)
    await Preferences.set({ key: cookieModeKey(id), value: 'secure' })
    return
  } catch (err) {
    insecureFallback = true
    console.warn('secure storage write failed, falling back to Preferences', err)
  }
  await Preferences.set({ key: cookieKey(id), value: cookie })
  await Preferences.set({ key: cookieModeKey(id), value: 'plain' })
}

export async function removeCookie(id: string): Promise<void> {
  try {
    await SecureStorage.remove(cookieKey(id))
  } catch {
    /* not present / unavailable */
  }
  await Preferences.remove({ key: cookieKey(id) })
  await Preferences.remove({ key: cookieModeKey(id) })
}

export async function cookieMode(id: string): Promise<'secure' | 'plain' | 'none'> {
  const { value } = await Preferences.get({ key: cookieModeKey(id) })
  if (value === 'secure') return 'secure'
  if (value === 'plain') return 'plain'
  return 'none'
}

/**
 * The chat this client last had open for a connection + bot.
 *
 * Sessions live on the gateway, not here: remembering the id means the phone can
 * re-attach to the very conversation the desktop app left running, including a
 * turn that is mid-flight.
 */
export async function loadLastSession(id: string, profile: string | null): Promise<string | null> {
  const { value } = await Preferences.get({ key: lastSessionKey(id, profile) })
  return value || null
}

export async function loadProfile(id: string): Promise<string | null> {
  const { value } = await Preferences.get({ key: profileKey(id) })
  return value || null
}

export async function saveProfile(id: string, profile: string | null): Promise<void> {
  const key = profileKey(id)
  if (profile) await Preferences.set({ key, value: profile })
  else await Preferences.remove({ key })
}

export async function saveLastSession(
  id: string,
  profile: string | null,
  sessionId: string | null,
): Promise<void> {
  const key = lastSessionKey(id, profile)
  if (sessionId) await Preferences.set({ key, value: sessionId })
  else await Preferences.remove({ key })
}

export async function deleteConnection(id: string): Promise<void> {
  await removeToken(id)
  await removePassword(id)
  await removeCookie(id)
  const connections = (await loadConnections()).filter((c) => c.id !== id)
  await saveConnections(connections)
}
