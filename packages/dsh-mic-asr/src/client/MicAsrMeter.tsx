/** Composer-dock live line while dictating: the input level with speech segments shaded, and the speaker score against the voiceprint filter line. */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DictationLevel, DictationState } from './dictation.ts'
import { NS } from './locales.ts'
import type { MicAsrConfigSnapshot } from './MicAsrDebug.tsx'
import css from './MicAsrMeter.module.css'

/** Business face injected by the browser plugin. */
export interface MicAsrMeterInjected {
  hooks: {
    dictation: HostObservable<DictationState>
    micConfig: HostObservable<MicAsrConfigSnapshot>
  }
}

/** Full props of the composer-dock entry. */
export type MicAsrMeterProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<typeof NS> & InjectFace<MicAsrMeterInjected>

const WIDTH = 120
const HEIGHT = 18
/** Level line slots; matches the dictation level history. */
const SLOTS = 60
const FLOOR_DBFS = -70
const CEILING_DBFS = -10
const SCORE_WIDTH = 64

function voiceField(value: Readonly<Record<string, unknown>> | undefined, name: string): unknown {
  const voice = value?.['voice']
  return typeof voice === 'object' && voice !== null ? (voice as Record<string, unknown>)[name] : undefined
}

function y(dbfs: number): number {
  const share = Math.max(0, Math.min(1, (dbfs - FLOOR_DBFS) / (CEILING_DBFS - FLOOR_DBFS)))
  return HEIGHT - 1 - share * (HEIGHT - 2)
}

function LevelLine({ levels }: { levels: readonly DictationLevel[] }) {
  const step = WIDTH / (SLOTS - 1)
  const offset = SLOTS - levels.length
  const points = levels.map((level, index) => `${((offset + index) * step).toFixed(1)},${y(level.dbfs).toFixed(1)}`).join(' ')
  return (
    <svg className={css.line} width={WIDTH} height={HEIGHT} viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} aria-hidden>
      {levels.map((level, index) => level.speaking && (
        <rect key={index} className={css.speech} x={((offset + index) * step) - step / 2} y={0} width={step} height={HEIGHT} />
      ))}
      <polyline className={css.level} points={points} />
    </svg>
  )
}

/**
 * Live dictation line shown in every composer dock while dictation runs.
 * @param props - injected dictation state and configuration, and locale.
 * @returns the line, or nothing while dictation is off.
 */
export function MicAsrMeter({ useDictation, useMicConfig, t }: MicAsrMeterProps) {
  const state = useDictation(snapshot => snapshot)
  const config = useMicConfig(snapshot => snapshot.value)
  if (state.phase !== 'listening' && state.phase !== 'loading') return null
  const threshold = Number(voiceField(config, 'speakerThreshold') ?? Number.NaN)
  const filterOff = voiceField(config, 'vadBarge') === true
  const live = state.score
  const last = state.finals[0]
  const score = live?.score ?? last?.score ?? null
  const provisional = live !== undefined && !live.decisive
  const passed = score !== null && Number.isFinite(threshold) && score >= threshold
  const tip = filterOff ? t('meter.filterOff')
    : t('meter.tip', { threshold: Number.isFinite(threshold) ? threshold.toFixed(2) : '—', score: score === null ? '—' : score.toFixed(2) })
  const position = (value: number): string => `${String(Math.max(0, Math.min(1, value)) * 100)}%`
  return (
    <Tooltip label={tip} side="top" portal>
      <span className={css.root} role="status" aria-label={tip} data-silent={state.silent}>
        <LevelLine levels={state.levels} />
        {filterOff
          ? <span className={css.off}>{t('meter.off')}</span>
          : (
              <span className={css.score} data-state={score === null ? 'none' : passed ? 'pass' : 'fail'} data-provisional={provisional}>
                <span>{t('meter.label')}</span>
                <span className={css.track} style={{ width: SCORE_WIDTH }}>
                  {Number.isFinite(threshold) && <i className={css.pass} style={{ left: position(threshold) }} />}
                  {Number.isFinite(threshold) && <i className={css.filter} style={{ left: position(threshold) }} />}
                  {score !== null && <b className={css.dot} style={{ left: position(score) }} />}
                </span>
                <span className={css.value}>{score === null ? '—' : score.toFixed(2)}</span>
                {score !== null && <span className={css.mark}>{passed ? '✓' : '✗'}</span>}
              </span>
            )}
      </span>
    </Tooltip>
  )
}
