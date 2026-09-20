export type Appearance = 'system' | 'light' | 'dark'
export type Palette = 'sage' | 'ocean' | 'rose'
export function readAppearance(): { appearance: Appearance; palette: Palette } {
  try {
    const value = JSON.parse(
      localStorage.getItem('solid-webui:appearance') ?? '{}',
    )
    return {
      appearance: ['system', 'light', 'dark'].includes(value.appearance)
        ? value.appearance
        : 'system',
      palette: ['sage', 'ocean', 'rose'].includes(value.palette)
        ? value.palette
        : 'sage',
    }
  } catch {
    return { appearance: 'system', palette: 'sage' }
  }
}
export function applyAppearance(appearance: Appearance, palette: Palette) {
  document.documentElement.dataset.appearance = appearance
  document.documentElement.dataset.palette = palette
  try {
    localStorage.setItem(
      'solid-webui:appearance',
      JSON.stringify({ appearance, palette }),
    )
  } catch {
    /* Storage may be blocked; the current session still works. */
  }
}
