/** Composer-toolbar microphone: dictation into this composer, a microphone menu, and the heard text, state and latest outcome above it. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconMicrophoneOutlineRegular, IconStopFillRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DictationNotice, DictationState, InsertText } from './dictation.ts'
import type { MicAsrRuntimeState } from '../types.ts'
import type { MicrophoneSnapshot } from './microphones.ts'
import { NS } from './locales.ts'
import css from './MicAsrButton.module.css'

/** Business face injected by the browser plugin. */
export interface MicAsrInjected {
  hooks: {
    /** Dictation snapshot bound by the renderer as useDictation. */
    dictation: HostObservable<DictationState>
    /** Microphone list and choice bound by the renderer as useMicrophones. */
    microphones: HostObservable<MicrophoneSnapshot>
  }
  /** Choose the microphone; dictation that is running restarts with it. */
  selectMicrophone: (id: string) => void
  /** Start dictating into a composer; called from the click. */
  start: (owner: object, insert: InsertText) => void
  /** Stop dictation. */
  stop: () => void
  /** Refresh the insert callback of the composer that owns dictation. */
  retarget: (owner: object, insert: InsertText) => void
}

/** Full props of the composer-toolbar control. */
export type MicAsrButtonProps = Pick<PropsRuntime<'conversation.input.right'>, 'inputActions'> & PropsLocale<typeof NS> & InjectFace<MicAsrInjected>

/** How long an outcome stays above the button. */
const NOTICE_MS = 4_000

function noticeText(notice: DictationNotice, t: TranslateNS<typeof NS>): string {
  switch (notice.kind) {
    case 'inserted': return t('inserted', { text: notice.text })
    case 'not-verified': return notice.enrolled ? t('notVerified', { text: notice.text }) : t('notEnrolled')
    case 'insert-failed': return t('insertFailed', { text: notice.text })
    case 'error': return t('failed', { message: notice.message })
  }
}

/**
 * Describe runtime preparation.
 * @param runtime - runtime state of the stream.
 * @param t - translator.
 * @returns the download percentage and size, or the unpacking step.
 */
export function preparingText(runtime: MicAsrRuntimeState | undefined, t: TranslateNS<typeof NS>): string {
  if (runtime?.phase === 'unpacking') return t('unpacking')
  if (runtime?.phase !== 'downloading') return t('preparing')
  const mb = (bytes: number): string => (bytes / (1 << 20)).toFixed(0)
  if (runtime.totalBytes === null) return t('downloadingBytes', { received: mb(runtime.receivedBytes) })
  return t('downloading', { percent: String(Math.floor(runtime.receivedBytes / runtime.totalBytes * 100)),
    received: mb(runtime.receivedBytes), total: mb(runtime.totalBytes) })
}

function statusText(state: DictationState, mine: boolean, t: TranslateNS<typeof NS>): string {
  if (!mine || state.phase === 'off') return state.phase === 'off' ? t('start') : t('otherComposer')
  switch (state.phase) {
    case 'connecting': return t('connecting')
    case 'preparing': return preparingText(state.runtime, t)
    case 'loading': return t('loading')
    case 'listening': return t('listening')
    case 'failed': return state.notice === undefined ? t('failedUnknown') : noticeText(state.notice, t)
  }
}

function microphoneLabel(snapshot: MicrophoneSnapshot, t: TranslateNS<typeof NS>): string {
  return snapshot.microphones.find(device => device.id === snapshot.microphone)?.label ?? t('systemDefault')
}

/**
 * Microphone button of one composer.
 * @param props - composer actions, injected dictation controls and locale.
 * @returns the button and its status bubble.
 */
export function MicAsrButton({ inputActions, useDictation, useMicrophones, start, stop, retarget, selectMicrophone, t }: MicAsrButtonProps) {
  const state = useDictation(snapshot => snapshot)
  const microphones = useMicrophones(snapshot => snapshot)
  const [menuOpen, setMenuOpen] = useState(false)
  const [owner] = useState(() => ({}))
  const mine = state.owner === owner
  const insert = useCallback<InsertText>(text => inputActions.insertText(text, inputActions.captureInsertion()), [inputActions])
  useEffect(() => { retarget(owner, insert) }, [owner, insert, retarget])
  // A composer that unmounts (another session opened) ends its own dictation.
  const mineRef = useRef(mine)
  mineRef.current = mine
  useEffect(() => () => { if (mineRef.current) stop() }, [stop])
  const [shownNotice, setShownNotice] = useState<DictationNotice | undefined>(undefined)
  useEffect(() => {
    if (!mine || state.notice === undefined) return
    setShownNotice(state.notice)
    if (state.phase === 'failed') return
    const timer = setTimeout(() => { setShownNotice(undefined) }, NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [mine, state.notice, state.phase])
  const active = mine && state.phase !== 'off' && state.phase !== 'failed'
  const bubble = !mine ? undefined
    : state.partial !== undefined && state.partial !== '' ? t('hearing', { text: state.partial })
      : shownNotice !== undefined ? noticeText(shownNotice, t)
        : state.phase === 'listening' && state.silent ? t('silent', { microphone: microphoneLabel(microphones, t) })
          : active ? statusText(state, mine, t) : undefined
  return (
    <span className={css.anchor}>
      <Tooltip label={active ? t('stop') : statusText(state, mine, t)} side="top" portal>
        <Button className={css.trigger} size="sm" aria-pressed={active} aria-label={active ? t('stop') : t('start')}
          data-active={active} data-speaking={active && state.inSegment}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { if (active) stop(); else start(owner, insert) }}>
          {active ? <IconStopFillRegular size={14} /> : <IconMicrophoneOutlineRegular size={18} />}
        </Button>
      </Tooltip>
      <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} side="top" align="end" portal
        items={[{ id: '', label: t('systemDefault') }, ...microphones.microphones.map(device => ({ id: device.id, label: device.label }))]}
        selectedId={microphones.microphone}
        onSelect={(id) => {
          setMenuOpen(false)
          selectMicrophone(id)
          if (active) start(owner, insert)
        }}
        anchor={(
          <Tooltip label={t('microphoneChoice', { microphone: microphoneLabel(microphones, t) })} side="top" portal>
            <Button className={css.chooser} size="sm" aria-label={t('microphone')} aria-haspopup="menu" aria-expanded={menuOpen}
              onMouseDown={(event) => { event.preventDefault() }} onClick={() => { setMenuOpen(open => !open) }}>
              <IconChevronDownOutlineRegular size={12} />
            </Button>
          </Tooltip>
        )} />
      {bubble !== undefined && <span className={css.bubble} role="status" title={bubble}>{bubble}</span>}
    </span>
  )
}
