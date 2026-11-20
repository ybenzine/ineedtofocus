// One Settings section (AC12.9, AC12.10): a card with a level-2 heading that wraps the toggle
// button. A heading around a button keeps the heading reachable by heading navigation, which a
// <summary> with an <h2> inside doesn't reliably do. Closing only hides the body (`hidden`): it
// stays mounted, so anything shown or typed in it is still there when the section is reopened.

import { useId, useState, type ReactNode } from 'react'

export default function SettingsSection({
  title,
  defaultOpen,
  children,
}: {
  title: string
  defaultOpen: boolean
  children: ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div role="region" aria-labelledby={`${id}-title`} className="settings-section">
      <h2 id={`${id}-title`}>
        <button
          type="button"
          className="settings-section-toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen(!open)}
        >
          <span>{title}</span>
          <span className="settings-section-chevron" aria-hidden="true" />
        </button>
      </h2>
      <div id={`${id}-body`} className="settings-section-body" hidden={!open}>
        {children}
      </div>
    </div>
  )
}
