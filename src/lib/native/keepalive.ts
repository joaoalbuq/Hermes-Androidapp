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
  /** May this app post chat notifications? (Android 13+ asks once.) */
  notifications: boolean
}

interface KeepAlivePlugin {
  start(): Promise<{ running: boolean }>
  stop(): Promise<{ running: boolean }>
  status(): Promise<{ running: boolean; exempt: boolean; notifications: boolean }>
  requestExemption(): Promise<{ exempt: boolean }>
  notify(options: { title: string; body: string; id?: number }): Promise<{
    posted: boolean
    permission: boolean
  }>
  requestNotifications(): Promise<{ notifications: boolean }>
}

const plugin = registerPlugin<KeepAlivePlugin>('KeepAlive')

export const keepAliveSupported = (): boolean => Capacitor.isNativePlatform()

const none: KeepAliveState = { supported: false, running: false, exempt: false, notifications: false }

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
    return {
      supported: true,
      running: !!result.running,
      exempt: !!result.exempt,
      notifications: !!result.notifications,
    }
  } catch {
    return { supported: true, running: false, exempt: false, notifications: false }
  }
}

/**
 * Tell the user something happened while the app was in the background.
 *
 * On Android this is a real notification (its own high-importance channel, so it
 * is not buried under the ongoing connection notice). In a desktop browser it
 * falls back to the Web Notifications API, which is also how the behaviour can be
 * exercised without a device.
 */
export async function notifyInBackground(title: string, body: string): Promise<boolean> {
  if (keepAliveSupported()) {
    try {
      const result = await plugin.notify({ title, body, id: 5000 + Math.floor(Math.random() * 400) })
      return !!result.posted
    } catch (err) {
      console.warn('notification failed', err)
      return false
    }
  }
  try {
    if (typeof Notification === 'undefined') return false
    if (Notification.permission === 'granted') {
      new Notification(title, { body })
      return true
    }
    if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        new Notification(title, { body })
        return true
      }
    }
  } catch (err) {
    console.warn('web notification failed', err)
  }
  return false
}

/** Ask for the Android 13+ notification permission (a no-op elsewhere). */
export async function requestNotificationPermission(): Promise<KeepAliveState> {
  if (!keepAliveSupported()) return keepAliveStatus()
  try {
    await plugin.requestNotifications()
  } catch (err) {
    console.warn('notification permission request failed', err)
  }
  return keepAliveStatus()
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
