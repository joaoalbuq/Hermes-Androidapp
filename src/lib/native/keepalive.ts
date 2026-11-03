import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Background keep-alive.
 *
 * A locked phone freezes the WebView: its timers stop, the gateway socket dies
 * and the page never hears about it. The native side runs a foreground service
 * with a partial wake lock and a high-performance Wi-Fi lock, which keeps this
 * page's JavaScript — and the heartbeat on the socket — running while the screen
 * is off, so a turn that finishes in the background lands in the transcript.
 *
 * In a desktop browser there is nothing to hold open; the calls are no-ops that
 * report `supported: false` so the settings UI can say so.
 */

export interface KeepAliveState {
  supported: boolean
  running: boolean
  exempt: boolean
}

interface KeepAlivePlugin {
  start(): Promise<{ running: boolean }>
  stop(): Promise<{ running: boolean }>
  status(): Promise<{ running: boolean; exempt: boolean }>
  requestExemption(): Promise<{ exempt: boolean }>
}

const plugin = registerPlugin<KeepAlivePlugin>('KeepAlive')

export const keepAliveSupported = (): boolean => Capacitor.isNativePlatform()

const none: KeepAliveState = { supported: false, running: false, exempt: false }

export async function startKeepAlive(): Promise<KeepAliveState> {
  if (!keepAliveSupported()) return none
  try {
    await plugin.start()
  } catch (err) {
    console.warn('keep-alive could not start', err)
  }
  return keepAliveStatus()
}

export async function stopKeepAlive(): Promise<KeepAliveState> {
  if (!keepAliveSupported()) return none
  try {
    await plugin.stop()
  } catch (err) {
    console.warn('keep-alive could not stop', err)
  }
  return keepAliveStatus()
}

export async function keepAliveStatus(): Promise<KeepAliveState> {
  if (!keepAliveSupported()) return none
  try {
    const result = await plugin.status()
    return { supported: true, running: !!result.running, exempt: !!result.exempt }
  } catch {
    return { supported: true, running: false, exempt: false }
  }
}

/** Open the system screen that lets Android stop freezing this app. */
export async function requestBatteryExemption(): Promise<KeepAliveState> {
  if (!keepAliveSupported()) return none
  try {
    await plugin.requestExemption()
  } catch (err) {
    console.warn('battery exemption request failed', err)
  }
  return keepAliveStatus()
}
