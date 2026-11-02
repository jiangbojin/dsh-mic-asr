/** Microphone choice of this browser, kept in localStorage. */

/** One selectable device; an empty id is the system default. */
export interface AudioDevice {
  readonly id: string
  readonly label: string
}

/** Microphone list and the current choice. */
export interface MicrophoneSnapshot {
  readonly microphones: readonly AudioDevice[]
  /** Selected microphone id; empty for the system default. */
  readonly microphone: string
}

const KEY = 'dsh.mic-asr.microphone'

function storedItem(key: string): string | null {
  try { return localStorage.getItem(key) } catch (error) {
    void error // unreadable storage counts as no saved choice
    return null
  }
}

function storeItem(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch (error) {
    void error // the choice still applies for this page
  }
}

function readSaved(): string {
  return storedItem(KEY) ?? ''
}

/** Observable microphone choice; refreshed on devicechange and after microphone permission. */
export class MicrophoneStore {
  private snapshot: MicrophoneSnapshot = { microphones: [], microphone: readSaved() }
  private readonly listeners = new Set<() => void>()
  private readonly onDevices = (): void => { void this.refresh() }

  constructor() {
    navigator.mediaDevices?.addEventListener('devicechange', this.onDevices)
    void this.refresh()
  }

  /**
   * Read the microphone list and choice.
   * @returns the current snapshot.
   */
  getSnapshot = (): MicrophoneSnapshot => this.snapshot

  /**
   * Observe changes.
   * @param listener - invalidation callback.
   * @returns disposer.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private update(patch: Partial<MicrophoneSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Re-read the microphone list; labels appear once microphone permission is granted. */
  async refresh(): Promise<void> {
    const devices = await navigator.mediaDevices?.enumerateDevices() ?? []
    this.update({ microphones: devices
      .filter(device => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== '')
      .map((device, index) => ({ id: device.deviceId, label: device.label === '' ? `audioinput ${String(index + 1)}` : device.label })) })
  }

  /**
   * Choose a microphone and keep the choice in this browser.
   * @param id - microphone id; empty for the system default.
   */
  select(id: string): void {
    storeItem(KEY, id)
    this.update({ microphone: id })
  }

  /** Stop listening for device changes. */
  dispose(): void {
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDevices)
    this.listeners.clear()
  }
}
