import { useEffect, useState, type RefObject } from 'react'

/**
 * The height that stretches an element from where it sits down to the bottom of
 * the window (less `margin`), so it can fill the screen without pushing the page
 * longer. A sticky element that has stuck at the top fills from there. Returns
 * undefined while `enabled` is false (narrow screens, where it flows normally).
 */
export function useFillViewport(ref: RefObject<HTMLElement | null>, enabled: boolean, margin = 16): number | undefined {
  const [height, setHeight] = useState<number>()
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = ref.current?.getBoundingClientRect().top
      if (top === undefined) return
      setHeight(Math.max(160, Math.round(window.innerHeight - Math.max(top, margin) - margin)))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ref, enabled, margin])
  return enabled ? height : undefined
}
