import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Bell,
  Blocks,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleUser,
  Clock,
  Code,
  Copy,
  Cpu,
  Database,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Info,
  KeyRound,
  Layers,
  LayoutGrid,
  ListFilter,
  Menu,
  Minus,
  Network,
  Palette,
  Plug,
  Plus,
  Puzzle,
  QrCode,
  RefreshCw,
  Save,
  Search,
  Send,
  Server,
  Settings2,
  Shield,
  Smile,
  Sparkles,
  SquareTerminal,
  Store,
  Trash2,
  Upload,
  User,
  X,
  type LucideIcon,
} from 'lucide-react'

/**
 * Product icon registry. Every glyph comes from `lucide-react`, so the set is
 * consistent, tree-shaken, and inherits `currentColor` instead of shipping a
 * sprite sheet. Pages name icons through this registry so extension metadata
 * keeps working even when it only carries a short text glyph.
 */
const icons = {
  overview: LayoutGrid,
  plugins: Blocks,
  extension: Puzzle,
  database: Database,
  logs: FileText,
  notifications: Bell,
  traffic: ArrowLeftRight,
  server: Server,
  network: Network,
  market: Store,
  account: CircleUser,
  settings: Settings2,
  palette: Palette,
  menu: Menu,
  close: X,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  alert: CircleAlert,
  info: Info,
  refresh: RefreshCw,
  search: Search,
  plug: Plug,
  layers: Layers,
  cpu: Cpu,
  sparkle: Sparkles,
  smile: Smile,
  minus: Minus,
  plus: Plus,
  send: Send,
  arrowDownLeft: ArrowDownLeft,
  arrowUpRight: ArrowUpRight,
  check: Check,
  copy: Copy,
  external: ExternalLink,
  trash: Trash2,
  eye: Eye,
  eyeOff: EyeOff,
  terminal: SquareTerminal,
  code: Code,
  clock: Clock,
  filter: ListFilter,
  download: Download,
  upload: Upload,
  ellipsis: Ellipsis,
  shield: Shield,
  user: User,
  key: KeyRound,
  qr: QrCode,
  save: Save,
} satisfies Record<string, LucideIcon>
export type IconName = keyof typeof icons
export const iconNames = Object.keys(icons) as IconName[]
export function hasIcon(name: string | undefined): name is IconName {
  return !!name && name in icons
}
/**
 * A short unicode glyph is how extension metadata names an icon that the shell
 * does not know (for example `↺`); rendering it as text keeps third-party pages
 * looking intentional without adding a glyph per plugin.
 */
function isGlyph(name: string) {
  return [...name].length <= 2
}
export interface IconProps {
  name: string
  size?: number
  strokeWidth?: number
  className?: string
  label?: string
}
export function Icon({
  name,
  size = 18,
  strokeWidth = 1.7,
  className,
  label,
}: IconProps) {
  const Glyph = icons[name as IconName]
  const accessibility = label
    ? { role: 'img' as const, 'aria-label': label }
    : { 'aria-hidden': true as const }
  if (Glyph)
    return (
      <Glyph
        size={size}
        strokeWidth={strokeWidth}
        className={'icon ' + (className ?? '')}
        {...accessibility}
      />
    )
  if (isGlyph(name))
    return (
      <span
        className={'icon-glyph ' + (className ?? '')}
        style={{ fontSize: size * 0.95, lineHeight: 1 }}
        {...accessibility}
      >
        {name}
      </span>
    )
  const Fallback = icons.extension
  return (
    <Fallback
      size={size}
      strokeWidth={strokeWidth}
      className={'icon ' + (className ?? '')}
      {...accessibility}
    />
  )
}
