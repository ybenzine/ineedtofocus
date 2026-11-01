// The dial: a ring that previews the session, with its numbers in the middle (AC9.5). The ring is
// decoration (`aria-hidden`); everything it shows is also in the text and the controls.

import type { ReactNode } from 'react'
import { arcDash, tickLine, LAP_MINUTES, type Arc } from './dial.ts'

const SIZE = 228
const CENTRE = SIZE / 2
const RADIUS = 104
const WIDTH = 12
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export default function Dial({
  arcs = [],
  ticks = [],
  className,
  children,
}: {
  arcs?: Arc[]
  /** Tick positions in minutes round the lap (Unlimited). */
  ticks?: number[]
  className?: string
  children: ReactNode
}) {
  return (
    <div className={className ? `dial ${className}` : 'dial'}>
      <svg
        className="dial-ring"
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
      >
        <circle className="dial-track" cx={CENTRE} cy={CENTRE} r={RADIUS} strokeWidth={WIDTH} />
        <circle className="dial-inner" cx={CENTRE} cy={CENTRE} r={RADIUS - 8} />
        {arcs.map((arc, index) => {
          const { dasharray, dashoffset } = arcDash(arc, CIRCUMFERENCE)
          return (
            <circle
              key={index}
              className={`dial-arc dial-arc-${arc.shade}`}
              cx={CENTRE}
              cy={CENTRE}
              r={RADIUS}
              strokeWidth={WIDTH}
              strokeDasharray={dasharray}
              strokeDashoffset={dashoffset}
              transform={`rotate(-90 ${CENTRE} ${CENTRE})`}
            />
          )
        })}
        {ticks.map((minute) => (
          <line
            key={minute}
            className="dial-tick"
            {...tickLine(minute / LAP_MINUTES, CENTRE, RADIUS + WIDTH / 2, RADIUS - WIDTH / 2)}
          />
        ))}
      </svg>
      <div className="dial-center">{children}</div>
    </div>
  )
}
