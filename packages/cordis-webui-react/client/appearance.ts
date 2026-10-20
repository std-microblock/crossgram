export type Appearance = 'system' | 'light' | 'dark'
export type Palette = 'sage' | 'ocean' | 'rose'
export const APPEARANCE_KEY = 'react-webui:appearance'
const appearances: Appearance[] = ['system', 'light', 'dark']
const palettes: Palette[] = ['sage', 'ocean', 'rose']
export function readAppearance(): {
  appearance: Appearance
  palette: Palette
} {
  try {
    const value = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}')
    return {
      appearance: appearances.includes(value.appearance)
        ? value.appearance
        : 'system',
      palette: palettes.includes(value.palette) ? value.palette : 'sage',
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
      APPEARANCE_KEY,
      JSON.stringify({ appearance, palette }),
    )
  } catch {
    /* Storage may be blocked; the current session still works. */
  }
}
