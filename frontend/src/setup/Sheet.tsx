// A bottom sheet over the New session screen (AC7.10, AC8.8): a modal dialog with focus trapped
// inside it. Done, Escape and a tap on the backdrop close it, and focus goes back to the row
// that opened it. An open dialog also holds back the automatic update (#244).

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { FOCUSABLE, tabbable } from './tabbable.ts'

export interface SheetProps {
  title: string
  onClose: () => void
  /** The row that opened the sheet; it gets focus back when the sheet closes. */
  returnFocusTo: RefObject<HTMLElement | null>
  /** What takes focus on opening; the first control when absent. */
  initialFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}

export default function Sheet({
  title,
  onClose,
  returnFocusTo,
  initialFocus,
  children,
}: SheetProps) {
  const titleId = useId()
  const dialog = useRef<HTMLElement>(null)
  // The newest callbacks, without re-running the effects that install them.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    const opener = returnFocusTo.current
    const first = dialog.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(initialFocus?.current ?? first ?? dialog.current)?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        close.current()
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const items = tabbable(dialog.current)
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const firstItem = items[0] as HTMLElement
      const lastItem = items[items.length - 1] as HTMLElement
      const active = document.activeElement
      if (!dialog.current.contains(active)) {
        event.preventDefault()
        firstItem.focus()
      } else if (event.shiftKey && active === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
    // Once, on opening: later renders of the sheet must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createPortal(
    <div className="sheet-layer">
      <div className="sheet-backdrop" aria-hidden="true" onClick={() => onClose()} />
      <section
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="sheet-done" onClick={() => onClose()}>
            Done
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  )
}
