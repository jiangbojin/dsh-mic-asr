/** dsh-mic-asr tuning page on the Plugins page: a dictation stream without a composer, live status, enrollment and live-applied voice parameters. */
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { useEffect, useRef, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DictationFinal, DictationState } from './dictation.ts'
import { preparingText } from './MicAsrButton.tsx'
import { NS, type MicAsrKey } from './locales.ts'
import type { MicrophoneSnapshot } from './microphones.ts'
import css from './MicAsrDebug.module.css'

/** One edit of the mic-asr entry's voice configuration. */
export type MicAsrConfigOp = { op: 'set'; path: readonly ['voice', string]; value: number | boolean } | { op: 'unset'; path: readonly ['voice', string] }

/** Accepted configuration as the Host serves it. */
export interface MicAsrConfigSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: Readonly<Record<string, unknown>> | undefined
  /** Raw user layer; a field present here is saved in the profile. */
  readonly user: unknown
  readonly writable: boolean
}

/** Business face injected by the browser plugin. */
export interface MicAsrDebugInjected {
  hooks: {
    dictation: HostObservable<DictationState>
    micConfig: HostObservable<MicAsrConfigSnapshot>
    microphones: HostObservable<MicrophoneSnapshot>
  }
  /** Identity of the page as a dictation owner; its finals are only listed. */
  owner: object
  /** Open the tuning stream and the microphone; called from the click. */
  startTuning: () => void
  stop: () => void
  /** Begin or end one enrollment recording, or clear the enrollment. */
  enroll: (action: 'begin' | 'end' | 'reset') => void
  selectMicrophone: (id: string) => void
  /** Write edits to the profile; voice fields reach the worker without a restart. */
  save: (ops: readonly MicAsrConfigOp[]) => Promise<boolean>
}

/** Full props of the bundle configuration contribution. */
export type MicAsrDebugProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof NS> & InjectFace<MicAsrDebugInjected>

type Control =
  | { readonly kind: 'range'; readonly min: number; readonly max: number; readonly step: number }
  | { readonly kind: 'number'; readonly step: number }
  | { readonly kind: 'switch'; readonly inverted?: true }
  | { readonly kind: 'choice'; readonly choices: readonly number[] }

/** Pipeline stages in processing order, each with its voice fields. */
const STAGES: readonly { readonly title: MicAsrKey; readonly fields: readonly (readonly [string, Control])[] }[] = [
  { title: 'debug.stage.denoise', fields: [['denoise', { kind: 'switch' }]] },
  { title: 'debug.stage.vad', fields: [
    ['vadThreshold', { kind: 'range', min: 0.2, max: 0.9, step: 0.05 }],
    ['vadMinSpeechMs', { kind: 'number', step: 10 }],
    ['vadMinSilenceMs', { kind: 'number', step: 50 }],
  ] },
  { title: 'debug.stage.asr', fields: [
    ['asrChunkMs', { kind: 'choice', choices: [160, 480] }],
    ['asrPrerollMs', { kind: 'number', step: 10 }],
  ] },
  { title: 'debug.stage.speaker', fields: [
    ['vadBarge', { kind: 'switch', inverted: true }],
    ['speakerThreshold', { kind: 'range', min: 0.2, max: 0.8, step: 0.01 }],
    ['verifyMs', { kind: 'number', step: 100 }],
  ] },
]

const SAMPLES: readonly MicAsrKey[] = ['debug.enroll.sample1', 'debug.enroll.sample2', 'debug.enroll.sample3']
/** Edits of sliders and number boxes are written after this pause. */
const COMMIT_DELAY_MS = 400
const FLOOR_DBFS = -80

function voiceValue(record: unknown, name: string): unknown {
  const voice = typeof record === 'object' && record !== null ? (record as Record<string, unknown>)['voice'] : undefined
  return typeof voice === 'object' && voice !== null ? (voice as Record<string, unknown>)[name] : undefined
}

function Meter({ label, dbfs, t }: { label: string; dbfs: number | undefined; t: TranslateNS<typeof NS> }) {
  const width = dbfs === undefined ? 0 : Math.max(0, Math.min(100, (dbfs - FLOOR_DBFS) / -FLOOR_DBFS * 100))
  return (
    <div className={css.meter}>
      <span>{label}</span>
      <span className={css.bar}><i style={{ width: `${String(width)}%` }} /></span>
      <b>{dbfs === undefined ? '—' : t('debug.dbfs', { value: String(dbfs) })}</b>
    </div>
  )
}

function finalText(final: DictationFinal, t: TranslateNS<typeof NS>): string {
  const parts = [t(`debug.reason.${final.reason}`)]
  if (final.score !== null) parts.push(t('debug.scoreValue', { score: final.score.toFixed(2) }))
  if (final.endToFinalMs !== null) parts.push(`${String(Math.round(final.endToFinalMs))} ms`)
  return parts.join(' · ')
}

/** One voice field whose edits are written to the profile as they settle. */
function VoiceField({ name, control, value, saved, disabled, commit, t }: {
  name: string; control: Control; value: unknown; saved: boolean; disabled: boolean
  commit: (value: number | boolean) => void; t: TranslateNS<typeof NS>
}) {
  const [draft, setDraft] = useState(String(value ?? ''))
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => { setDraft(String(value ?? '')) }, [value])
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  const later = (text: string): void => {
    setDraft(text)
    clearTimeout(timer.current)
    const number = Number(text)
    if (text.trim() === '' || !Number.isFinite(number)) return
    timer.current = setTimeout(() => { commit(number) }, COMMIT_DELAY_MS)
  }
  let input
  switch (control.kind) {
    case 'range':
      input = (<>
        <input type="range" min={control.min} max={control.max} step={control.step} value={draft} disabled={disabled}
          onChange={(event) => { later(event.target.value) }} />
        <b>{Number(draft).toFixed(2)}</b>
      </>)
      break
    case 'number':
      input = <input type="number" step={control.step} value={draft} disabled={disabled} onChange={(event) => { later(event.target.value) }} />
      break
    case 'switch':
      input = <input type="checkbox" checked={(draft === 'true') !== (control.inverted === true)} disabled={disabled}
        onChange={(event) => { commit(event.target.checked !== (control.inverted === true)) }} />
      break
    case 'choice':
      input = (
        <select value={draft} disabled={disabled} onChange={(event) => { commit(Number(event.target.value)) }}>
          {control.choices.map(choice => <option key={choice} value={String(choice)}>{choice}</option>)}
        </select>
      )
      break
  }
  return (
    <label className={css.field}>
      <span className={css.fieldHead}>{t(`debug.field.${name}` as MicAsrKey)}{saved && <Tag tone="neutral">{t('debug.saved')}</Tag>}</span>
      <span className={css.control}>{input}</span>
      <span className={css.help}>{t(`debug.help.${name}` as MicAsrKey)}</span>
    </label>
  )
}

function Enrollment({ state, ready, enroll, t }: { state: DictationState; ready: boolean; enroll: MicAsrDebugInjected['enroll']; t: TranslateNS<typeof NS> }) {
  const { enrollment } = state
  const next = Math.min(enrollment.segmentsOk, 2)
  const sampleState = (index: number): string => enrollment.enrolled || index < enrollment.segmentsOk ? 'done' : index === next ? 'current' : 'pending'
  const step = enrollment.recording
    ? { action: 'end' as const, label: t('debug.enroll.end'), primary: true }
    : { action: 'begin' as const, label: enrollment.enrolled ? t('debug.enroll.again') : t('debug.enroll.begin', { n: String(next + 1) }), primary: false }
  const notes = [
    enrollment.enrolled ? t('debug.enroll.done', { scores: enrollment.pairScores.map(score => score.toFixed(2)).join(' / ') }) : t('debug.enroll.intro'),
    ...state.enrollMessage === undefined ? [] : [state.enrollMessage],
    ...ready ? [] : [t('debug.enroll.needStream')],
  ]
  return (
    <div className={css.stack}>
      <ol className={css.samples}>{SAMPLES.map((sample, index) => <li key={sample} data-state={sampleState(index)}>{t(sample)}</li>)}</ol>
      {enrollment.recording && <p className={css.recording}>{t('debug.enroll.recording', { n: String(next + 1) })}</p>}
      {notes.map(note => <p key={note} className={css.hint}>{note}</p>)}
      <div className={css.row}>
        <Button size="sm" variant={step.primary ? 'primary' : 'outline'} disabled={!step.primary && !ready} onClick={() => { enroll(step.action) }}>{step.label}</Button>
        {(enrollment.enrolled || enrollment.segmentsOk > 0) && (
          <Button size="sm" variant="ghost" disabled={!ready} onClick={() => { enroll('reset') }}>{t('debug.enroll.reset')}</Button>
        )}
      </div>
    </div>
  )
}

/**
 * Tuning page: live status of the dictation stream, enrollment, and voice parameters applied as they are edited.
 * @param props - slot runtime, injected stores and actions, and locale.
 * @returns the page body, or nothing in the one-line summary view.
 */
export function MicAsrDebug(props: MicAsrDebugProps) {
  const { view, useDictation, useMicConfig, useMicrophones, owner, save, t } = props
  const state = useDictation(snapshot => snapshot)
  const config = useMicConfig(snapshot => snapshot)
  const microphones = useMicrophones(snapshot => snapshot)
  const [result, setResult] = useState<'saved' | 'refused' | undefined>(undefined)
  if (view !== 'page') return null
  const mine = state.owner === owner
  const running = mine && state.phase !== 'off' && state.phase !== 'failed'
  const ready = mine && state.phase === 'listening'
  const disabled = config.status !== 'ready' || !config.writable
  const write = (ops: readonly MicAsrConfigOp[]): void => {
    void save(ops).then((ok) => { setResult(ok ? 'saved' : 'refused') })
  }
  const savedFields = STAGES.flatMap(stage => stage.fields.map(([name]) => name)).filter(name => voiceValue(config.user, name) !== undefined)
  const score = state.score
  const last = state.finals[0]
  const status: [MicAsrKey, string][] = [
    ['debug.phase', mine && state.phase === 'preparing' ? preparingText(state.runtime, t) : t(`debug.phaseValue.${mine ? state.phase : 'off'}`)],
    ['debug.vad', state.inSegment ? t('debug.vad.speaking') : t('debug.vad.quiet')],
    ['debug.partial', state.partial === undefined || state.partial === '' ? '—' : state.partial],
    ['debug.score', score === undefined ? '—' : `${score.score.toFixed(2)} · ${t(score.accepted ? 'debug.accepted' : 'debug.rejected')}${score.decisive ? '' : ` · ${t('debug.provisional')}`}`],
    ['debug.last', last === undefined ? '—' : `${last.text || '—'}（${finalText(last, t)}）`],
  ]
  return (
    <div className={css.root}>
      <section>
        <h4>{t('debug.microphone')}</h4>
        <select className={css.select} value={microphones.microphone} onChange={(event) => { props.selectMicrophone(event.target.value) }}>
          <option value="">{t('systemDefault')}</option>
          {microphones.microphones.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
        </select>
        {microphones.microphones.length > 0 && microphones.microphones.every(device => device.label.startsWith('audioinput')) && (
          <p className={css.hint}>{t('debug.labelsHint')}</p>
        )}
      </section>
      <section>
        <h4>{t('debug.stream')}</h4>
        <div className={css.row}>
          {running
            ? <Button size="sm" variant="outline" onClick={props.stop}>{t('stop')}</Button>
            : <Button size="sm" variant="primary" onClick={props.startTuning}>{t('debug.start')}</Button>}
          {!mine && state.phase !== 'off' && <span className={css.hint}>{t('debug.composerStream')}</span>}
          {mine && state.phase === 'failed' && state.notice?.kind === 'error' && <span className={css.error}>{state.notice.message}</span>}
        </div>
      </section>
      <section>
        <h4>{t('debug.live')}</h4>
        <Meter label={t('debug.rawLevel')} dbfs={mine ? state.rawDbfs : undefined} t={t} />
        <Meter label={t('debug.level')} dbfs={mine ? state.levelDbfs : undefined} t={t} />
        {mine && state.silent && <p className={css.error}>{t('debug.silent')}</p>}
        <dl className={css.status}>
          {status.map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}
        </dl>
        {state.finals.length > 0 && (
          <ol className={css.finals}>
            {state.finals.map((final, index) => (
              <li key={state.finals.length - index} data-reason={final.reason}>{final.text || '—'}<small>{finalText(final, t)}</small></li>
            ))}
          </ol>
        )}
      </section>
      <section>
        <h4>{t('debug.enroll')}</h4>
        <Enrollment state={state} ready={ready} enroll={props.enroll} t={t} />
      </section>
      {STAGES.map(stage => (
        <section key={stage.title}>
          <h4>{t(stage.title)}</h4>
          <div className={css.grid}>
            {stage.fields.map(([name, control]) => (
              <VoiceField key={name} name={name} control={control} value={voiceValue(config.value, name)} saved={savedFields.includes(name)}
                disabled={disabled} commit={(value) => { write([{ op: 'set', path: ['voice', name], value }]) }} t={t} />
            ))}
          </div>
        </section>
      ))}
      <div className={css.row}>
        <Button size="sm" variant="ghost" disabled={disabled || savedFields.length === 0}
          onClick={() => { write(savedFields.map(name => ({ op: 'unset' as const, path: ['voice', name] as const }))) }}>{t('debug.defaults')}</Button>
        {result !== undefined && <span className={css.hint}>{t(result === 'saved' ? 'debug.result.saved' : 'debug.result.refused')}</span>}
      </div>
      <p className={css.hint}>{t('debug.liveHint')}</p>
    </div>
  )
}
