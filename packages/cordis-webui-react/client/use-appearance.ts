import { useSyncExternalStore } from 'react'
import {
  applyAppearance,
  readAppearance,
  type Appearance,
  type Palette,
} from './appearance.js'

let snapshot =
  typeof localStorage === 'undefined'
    ? { appearance: 'system' as Appearance, palette: 'sage' as Palette }
    : readAppearance()
const listeners = new Set<() => void>()
function emit() {
  for (const listener of listeners) listener()
}
/** Applies an appearance choice and notifies every subscribed surface. */
export function setAppearance(appearance: Appearance, palette: Palette) {
  applyAppearance(appearance, palette)
  snapshot = { appearance, palette }
  emit()
}
/** Current appearance preference, kept in sync with the document attributes. */
export function useAppearance() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => snapshot,
    () => snapshot,
  )
}
