---
name: webui-react-design
description: Design and review Crossgram WebUI (React) changes — DSH design tokens, reuse-before-adding, feedback surfaces, overlay safety, loading states, and copy placement. Use when adding or changing user-visible UI under packages/cordis-webui-react or a plugin's client/ page.
---

# Crossgram WebUI design (DSH system)

The React WebUI adopts the DeepSeek Harness (DSH) design language. The token
sheets and base stylesheet are vendored from `deepseek-harness`
(`packages/client/ui-theme/src/styles`), and the component geometry follows the
DSH radius and material standards. Treat this as guidance on top of the token
rules, not a second copy of them.

## Where the design lives

- `packages/cordis-webui-react/client/styles/tokens.css` — the `--dsw-*` static
  palette and semantic aliases for light/dark, driven by
  `data-appearance="system|light|dark"` on `<html>`.
- `packages/cordis-webui-react/client/styles/base.css` — font stacks, focus
  ring, corner-shape smoothing, scrollbar skin, reduced motion.
- `packages/cordis-webui-react/client/theme.css` — shell layout, page classes,
  and a `@layer refinements` block that maps the app's classes onto DSH
  materials (`--dsw-elevation-*`, `--dsw-alias-bg-layer-*`, hairline borders).
- `packages/cordis-webui-react/client/components.tsx` — `PageHeader`,
  `EmptyState`, `LiveContent`, `Modal`, `ConfirmAction`, `ActionError`,
  `Notice`, `Loading`, `JsonView`, `useAction`, `useAsync`.
- `packages/cordis-webui-react/client/icons.tsx` — `lucide-react` glyph registry.

The old palette preference (`data-palette="sage|ocean|rose"`) survives as the
single workspace accent (`--webui-accent`); everything else is neutral DSH ink
and surfaces.

## Visual foundation

- Use existing tokens for color, radius, spacing, and typography. Before adding
  a literal value, search the page and its nearest sibling for the token or
  value already in use.
- Verify every color pair in both light and dark. Dimmed tones are for
  decorative surfaces only; never use them for text without checking both
  themes.
- Font weight tops out at 500 in feature CSS. Differentiate with size or ink.
- Pick font sizes from existing roles: 12–13px for dense rows and details,
  14px body, 24px page titles. Do not invent a size for one element.
- Icons, text, and neighbouring elements share a deliberate alignment axis; an
  icon stays proportionate to the text beside it.

## Reuse before adding

- Extend an existing component or class before creating a parallel one; add a
  prop or variant instead of a copy.
- Icons come from the `lucide-react` registry in `icons.tsx`. Pick the
  semantically closest existing glyph; a new glyph is a deliberate addition.
- Icon-only actions whose meaning is not obvious get a `title` or
  `aria-label`; informational content that needs pointer rest gets a tooltip
  pattern rather than an ad-hoc popup.
- Buttons use the shared `.button` variants (`filled`, `tonal`, `outlined`,
  `danger`) and `.icon-button`; forms use `.field` + native controls; cards
  use `.panel`; status badges use `.chip`.

## Feedback surfaces

- Transient operation outcomes surface immediately and do not unmount with the
  panel that requested them: prefer the toast surface (`sonner`, already wired
  in the shell) for success/failure of one-shot actions, and keep the data
  visible when the action fails.
- In-place notices are for states tied to the surface itself: a query failure
  with its Retry action, field validation on the form owning the field, or a
  reconnect/update banner from the shell.
- Error copy is plain, short, and one sentence where possible; a Chinese notice
  of at most two sentences omits the trailing 句号. A notice must not shift
  neighbouring elements; reserve its space.

## Loading states

- Lists use their skeleton/spinner once per page; every other page-level load
  centers a bare spinner. Never place a spinner in a page corner.
- One loading treatment per page/component; concurrent regions must not each
  flash their own style.
- `LiveContent` keeps the last payload visible while the channel is stale; do
  not blank content that already loaded.

## Overlays and menus

Every menu, popover, tooltip, and modal must be dismissable (outside click and
Escape), viewport-fitting (flip or slide with an edge margin), and unclipped
(portal to `body` where an ancestor could clip it). `Modal` renders a native
`<dialog>` so Escape, focus, and top-layer stacking are platform behaviour.

Scrollbars stay inside their container and use the shared scrollbar skin; never
add component-local scrollbar selectors.

## Radius and materials

Follow the DSH scale: 4px small details, 8px compact controls, 12px standard
controls/inputs/buttons/nav rows, 16px large controls and grouped content, 20px
independent cards, 28px dialogs and main panels. Circles and capsules pair
`corner-shape: round` with their full radius. Elevated surfaces carry the
hairline stroke inside `--dsw-elevation-*`, so they use `border: 0`; ordinary
cards keep the 0.5px neutral border.

## Verify

1. Check normal, hover, pressed/selected, disabled, and keyboard-focus states in
   light and dark.
2. Check a narrow (≈390px) layout: sidebar becomes a drawer, tables scroll
   inside their container, toolbars wrap.
3. Run `yarn typecheck:webui:react` and the WebUI tests; UI behaviour changes
   need a browser e2e assertion, not only CSS values.
