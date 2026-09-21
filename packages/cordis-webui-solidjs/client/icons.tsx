/** @jsxImportSource solid-js */
import { type JSX } from 'solid-js'

/**
 * Minimal stroke icon set on a 24px grid. Glyphs are paths only, so every icon inherits
 * currentColor and the surrounding type size instead of shipping a font or sprite sheet.
 */
const glyphs: Record<string, () => JSX.Element> = {
  overview: () => (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </>
  ),
  plugins: () => (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <path d="M17 12.5v9M12.5 17h9" />
    </>
  ),
  extension: () => (
    <>
      <path d="M9 4.5h6v3a1.5 1.5 0 0 0 3 0v-3h1.5A1.5 1.5 0 0 1 21 6v1.5h-3a1.5 1.5 0 0 0 0 3h3V15a1.5 1.5 0 0 1-1.5 1.5H16a1.5 1.5 0 0 0 0 3h.5v.5A1.5 1.5 0 0 1 15 21H9a1.5 1.5 0 0 1-1.5-1.5V16a1.5 1.5 0 0 0-3 0H4.5A1.5 1.5 0 0 1 3 14.5v-5A1.5 1.5 0 0 1 4.5 8H5a1.5 1.5 0 0 0 0-3H4.5A1.5 1.5 0 0 1 6 3.5h1.5v1A1.5 1.5 0 0 0 9 6Z" />
    </>
  ),
  database: () => (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </>
  ),
  logs: () => (
    <>
      <path d="M5 4.5h9.5L19 9v10.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z" />
      <path d="M14 4.5V9h4.5" />
      <path d="M7.5 12.5h7M7.5 16h5" />
    </>
  ),
  notifications: () => (
    <>
      <path d="M18 9a6 6 0 1 0-12 0c0 4.5-1.5 5.5-1.5 5.5h15S18 13.5 18 9Z" />
      <path d="M10.2 18.5a2 2 0 0 0 3.6 0" />
    </>
  ),
  traffic: () => (
    <>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </>
  ),
  server: () => (
    <>
      <rect x="3" y="4" width="18" height="6.5" rx="2" />
      <rect x="3" y="13.5" width="18" height="6.5" rx="2" />
      <path d="M7 7.25h.01M7 16.75h.01" />
    </>
  ),
  network: () => (
    <>
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="5" cy="18.5" r="2.2" />
      <circle cx="19" cy="18.5" r="2.2" />
      <path d="M12 7.2v4.3M12 11.5 6.4 16.6M12 11.5l5.6 5.1" />
    </>
  ),
  market: () => (
    <>
      <path d="M4 8h16l-1.4 11.2a2 2 0 0 1-2 1.8H7.4a2 2 0 0 1-2-1.8Z" />
      <path d="M8.75 8V6.5a3.25 3.25 0 1 1 6.5 0V8" />
    </>
  ),
  account: () => (
    <>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20.5a7 7 0 0 1 14 0" />
    </>
  ),
  capture: () => (
    <>
      <path d="M3 12h3.5l2.5-6 3.5 12 2.5-6H21" />
    </>
  ),
  statistics: () => (
    <>
      <path d="M4 20.5h16" />
      <path d="M7 20.5V11M12 20.5V4.5M17 20.5v-6" />
    </>
  ),
  settings: () => (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="8" cy="17" r="2.2" />
    </>
  ),
  search: () => (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  refresh: () => (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.5V11h-6.5" />
    </>
  ),
  close: () => <path d="M6 6l12 12M18 6 6 18" />,
  menu: () => <path d="M4 7h16M4 12h16M4 17h16" />,
  chevronRight: () => <path d="m9.5 6 6 6-6 6" />,
  chevronDown: () => <path d="m6 9.5 6 6 6-6" />,
  chevronLeft: () => <path d="m14.5 6-6 6 6 6" />,
  plus: () => <path d="M12 5v14M5 12h14" />,
  minus: () => <path d="M5 12h14" />,
  trash: () => (
    <>
      <path d="M4.5 7h15M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </>
  ),
  check: () => <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5M12 16h.01" />
    </>
  ),
  info: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 8h.01" />
    </>
  ),
  external: () => (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V7.5A1.5 1.5 0 0 1 5.5 6H10" />
    </>
  ),
  copy: () => (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 6.5V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15h1" />
    </>
  ),
  play: () => <path d="M8 5.5v13l10-6.5Z" />,
  pause: () => <path d="M9 5.5v13M15 5.5v13" />,
  download: () => (
    <>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  upload: () => (
    <>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  filter: () => <path d="M4 5.5h16l-6 7v6l-4-2v-4Z" />,
  lock: () => (
    <>
      <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </>
  ),
  key: () => (
    <>
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m10 13 8.5-8.5M16 7l2.5 2.5M14 9l2.5 2.5" />
    </>
  ),
  arrowLeft: () => <path d="M19 12H5M11 6l-6 6 6 6" />,
  arrowRight: () => <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowUpRight: () => <path d="M7 17 17 7M9 7h8v8" />,
  arrowDownLeft: () => <path d="M17 7 7 17M15 17H7V9" />,
  sun: () => (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>
  ),
  moon: () => (
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  ),
  palette: () => (
    <>
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-.9 2-1.8 0-1.4-1.3-1.7-1.3-2.7 0-.8.7-1.5 1.6-1.5h1.9a4.3 4.3 0 0 0 4.3-4.3c0-3.7-3.8-6.7-8.5-6.7Z" />
      <path d="M7.5 11h.01M10 7.5h.01M14 7h.01M16.5 10.5h.01" />
    </>
  ),
  plug: () => (
    <>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11v4a5.5 5.5 0 0 1-11 0Z" />
      <path d="M12 17v3.5" />
    </>
  ),
  clock: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  cpu: () => (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3" />
    </>
  ),
  layers: () => (
    <>
      <path d="m12 3.5 8.5 4.5L12 12.5 3.5 8Z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
    </>
  ),
  shield: () => (
    <>
      <path d="M12 3.5 5 6v6c0 4.2 2.9 7.4 7 8.5 4.1-1.1 7-4.3 7-8.5V6Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  globe: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z" />
    </>
  ),
  sparkle: () => (
    <>
      <path d="M12 3.5 13.7 9l5.3 1.8-5.3 1.8L12 18l-1.7-5.4L5 10.8 10.3 9Z" />
      <path d="M18.5 16.5 19 18l1.5.5L19 19l-.5 1.5-.5-1.5L16.5 18.5 18 18Z" />
    </>
  ),
  more: () => (
    <>
      <circle cx="12" cy="5.5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="18.5" r="1.4" />
    </>
  ),
  smile: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 10h.01M15 10h.01" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    </>
  ),
  bot: () => (
    <>
      <rect x="4.5" y="8" width="15" height="12" rx="3" />
      <path d="M12 4.5V8" />
      <circle cx="12" cy="3.6" r="1" />
      <path d="M9.5 13h.01M14.5 13h.01" />
      <path d="M2.5 12.5v3M21.5 12.5v3" />
    </>
  ),
  send: () => (
    <>
      <path d="M20.5 3.5 3.5 10.3l7 2.7 2.7 7Z" />
      <path d="m10.5 13 10-9.5" />
    </>
  ),
  link: () => (
    <>
      <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 1 0-5-5l-1 1" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 1 0 5 5l1-1" />
    </>
  ),
  dot: () => (
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  ),
}

export type IconName = keyof typeof glyphs | (string & {})

export function Icon(props: {
  name: IconName
  size?: number
  class?: string
  strokeWidth?: number
}) {
  const glyph = () => glyphs[props.name] ?? glyphs.extension
  return (
    <svg
      class={'icon' + (props.class ? ' ' + props.class : '')}
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 1.6}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {glyph()()}
    </svg>
  )
}

export function hasIcon(name: string): boolean {
  return Object.hasOwn(glyphs, name)
}
