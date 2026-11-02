/** Registration of the micCapture service, the mic-asr Remote, the composer-toolbar microphone, the composer-dock live line and the tuning page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from 'dsh-mic-asr/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { DictationClient } from './dictation.ts'
import { en, NS, zh, type MicAsrKey } from './locales.ts'
import { MicAsrButton, type MicAsrInjected } from './MicAsrButton.tsx'
import { MicAsrDebug, type MicAsrConfigSnapshot, type MicAsrDebugInjected } from './MicAsrDebug.tsx'
import { MicAsrMeter, type MicAsrMeterInjected } from './MicAsrMeter.tsx'
import { MicrophoneStore } from './microphones.ts'
import { micCaptureService, type MicCaptureService } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Microphone choice and capture shared by the voice plugins of this window. */
    micCapture: MicCaptureService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Microphone dictation copy. */
    'mic-asr': MicAsrKey
  }
}

/** Required browser services. */
export const inject = ['remote', 'slots', 'locale', 'configForms']

/** Toolbar position after the prompt-enhance entry, which registers at order 0. */
const ORDER = 1
/** Composer-dock position after the activity and usage pills, which register at orders 0 and 1. */
const DOCK_ORDER = 2
/** Bundle whose Plugins page hosts the tuning page. */
const BUNDLE = 'dsh-mic-asr'
/** Row id of the mic-asr entry in the bundle patch. */
const ENTRY = 'mic-asr'

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const client = new DictationClient(() => ctx.remote.micAsr.connect(), ctx.micCapture)
  ctx.effect(() => async () => { await client.stop() })
  const actions: MicAsrInjected = {
    hooks: { dictation: client, microphones: ctx.micCapture.microphones },
    selectMicrophone: (id) => { ctx.micCapture.microphones.select(id) },
    start: (owner, insert) => {
      void client.start(owner, insert).catch((error: unknown) => { ctx.logger.warn('mic-asr stream failed', error) })
    },
    stop: () => { void client.stop() },
    retarget: (owner, insert) => { client.retarget(owner, insert) },
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'mic-asr', order: ORDER, locale: NS, inject: () => actions,
  }, MicAsrButton))
  const config = ctx.configForms.get<Record<string, unknown>>(ENTRY)
  const micConfig = { getSnapshot: (): MicAsrConfigSnapshot => config.getSnapshot(), subscribe: (listener: () => void) => config.subscribe(listener) }
  const meter: MicAsrMeterInjected = { hooks: { dictation: client, micConfig } }
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'mic-asr', order: DOCK_ORDER, locale: NS, inject: () => meter,
  }, MicAsrMeter))
  const page = {}
  const debug: MicAsrDebugInjected = {
    hooks: {
      dictation: client,
      micConfig,
      microphones: ctx.micCapture.microphones,
    },
    owner: page,
    // The page lists its finals instead of inserting them anywhere.
    startTuning: () => { actions.start(page, () => true) },
    stop: actions.stop,
    enroll: (action) => { client.enroll(action) },
    selectMicrophone: actions.selectMicrophone,
    save: async ops => await config.mutate(ops.map(op => op.op === 'set' ? { op: 'set', path: [...op.path], value: op.value } : { op: 'unset', path: [...op.path] })),
  }
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: BUNDLE, locale: NS, inject: () => debug,
  }, MicAsrDebug))
}

/**
 * Provide micCapture, then mount the mic-asr Remote namespace and the composer control.
 * @param ctx - Client runtime owning the Remote, dictionaries and slots.
 * @param contribution - generated mic-asr Remote definitions.
 * @returns disposer joining UI, Remote and service withdrawal.
 */
export async function mountMicAsr(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const microphones = new MicrophoneStore()
  const withdraw = ctx.reflect.provide('micCapture', micCaptureService(microphones))
  const disposeService = (): void => {
    withdraw()
    microphones.dispose()
  }
  let disposeRemote: () => Promise<void>
  try { disposeRemote = await ctx.remote.$mount(contribution) } catch (error) { disposeService(); throw error }
  const ui = ctx.inject(['remote.micAsr', 'micCapture', 'slots', 'locale', 'configForms'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); disposeService(); throw error }
  return async () => { await ui.dispose(); await disposeRemote(); disposeService() }
}
