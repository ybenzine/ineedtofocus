// The setup screen's icons: inline, decorative, drawn in the text colour (`currentColor`).

import type { ReactNode } from 'react'

function Icon({
  size,
  strokeWidth = 1.8,
  children,
}: {
  size: number
  strokeWidth?: number
  children: ReactNode
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

export const TagIcon = () => (
  <Icon size={20}>
    <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </Icon>
)

export const GoalIcon = () => (
  <Icon size={20}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" />
  </Icon>
)

export const SoundIcon = () => (
  <Icon size={20}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Icon>
)

export const NoSoundIcon = () => (
  <Icon size={16} strokeWidth={1.9}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="m22 9-6 6M16 9l6 6" />
  </Icon>
)

export const RainIcon = () => (
  <Icon size={16} strokeWidth={1.9}>
    <path d="M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3" />
    <path d="M8 19v2M8 13v2M16 19v2M16 13v2M12 21v2M12 15v2" />
  </Icon>
)

export const YoutubeIcon = () => (
  <Icon size={16} strokeWidth={1.9}>
    <rect x="2" y="5" width="20" height="14" rx="4" />
    <path d="m10 9 5 3-5 3z" />
  </Icon>
)

export const ChevronIcon = () => (
  <Icon size={18} strokeWidth={2}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon size={16} strokeWidth={2.4}>
    <path d="m5 12 5 5 9-10" />
  </Icon>
)

export const PlusIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const MinusIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2}>
    <path d="M5 12h14" />
  </Icon>
)

/** A small clock: marks the recent custom time among the presets (#409). */
export const RecentIcon = () => (
  <svg
    aria-hidden="true"
    focusable="false"
    className="preset-recent-icon"
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)
