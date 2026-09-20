import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAppearance, readAppearance } from './appearance.js'
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})
describe('local appearance preferences', () => {
  it('defaults safely and ignores corrupt or unsupported preferences', () => {
    expect(readAppearance()).toEqual({ appearance: 'system', palette: 'sage' })
    localStorage.setItem('solid-webui:appearance', '{')
    expect(readAppearance().appearance).toBe('system')
    localStorage.setItem(
      'solid-webui:appearance',
      JSON.stringify({ appearance: 'other', palette: 'other' }),
    )
    expect(readAppearance()).toEqual({ appearance: 'system', palette: 'sage' })
  })
  it('updates the document immediately, persists preferences, and tolerates denied storage', () => {
    applyAppearance('dark', 'ocean')
    expect(document.documentElement.dataset.appearance).toBe('dark')
    expect(readAppearance()).toEqual({ appearance: 'dark', palette: 'ocean' })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('blocked')
    })
    expect(() => applyAppearance('light', 'rose')).not.toThrow()
    expect(document.documentElement.dataset.palette).toBe('rose')
  })
})
