/** The colour families every status-like component draws from. */
export type Tone = 'ok' | 'bad' | 'warn' | 'neutral'

/** The one place a tone becomes classes; Badge and Notice both use it. */
export const toneClasses: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  bad: 'bg-bad-soft text-bad',
  warn: 'bg-warn-soft text-warn',
  neutral: 'bg-line text-muted',
}
