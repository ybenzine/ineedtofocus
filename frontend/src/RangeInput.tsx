import type { CSSProperties, InputHTMLAttributes } from 'react'

/**
 * A slider whose track is filled up to the thumb. WebKit and Blink can't style the filled part
 * of the track, so the value goes to CSS as `--fill` (0-1) and index.css draws it.
 */
export default function RangeInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { value: number },
) {
  const min = Number(props.min ?? 0)
  const max = Number(props.max ?? 100)
  const fraction = max > min ? Math.min(1, Math.max(0, (props.value - min) / (max - min))) : 0
  return <input {...props} type="range" style={{ '--fill': fraction } as CSSProperties} />
}
