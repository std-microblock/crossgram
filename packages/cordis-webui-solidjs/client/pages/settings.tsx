/** @jsxImportSource solid-js */
import { createSignal, For } from 'solid-js'
import { applyAppearance, readAppearance, type Appearance, type Palette } from '../appearance.js'
import { PageHeader } from '../components.js'
export default function SettingsPage() {
  const initial = readAppearance()
  const [appearance, setAppearance] = createSignal(initial.appearance), [palette, setPalette] = createSignal(initial.palette)
  const update = (mode: Appearance, color: Palette) => { setAppearance(mode); setPalette(color); applyAppearance(mode, color) }
  return <><PageHeader title="Make yourself at home" description="A little more you. A little less noise." /><section class="panel stack settings-panel"><h2>Appearance</h2><label class="field"><span>Color mode</span><select value={appearance()} onChange={event => update(event.currentTarget.value as Appearance, palette())}><option value="system">Follow your device</option><option value="light">Light</option><option value="dark">Dark</option></select></label><fieldset class="palette-options"><legend>Workspace color</legend><For each={['sage', 'ocean', 'rose'] as const}>{color => <label><input type="radio" name="palette" value={color} checked={palette() === color} onChange={() => update(appearance(), color)} /><span class={'color-sample ' + color} /><span>{color}</span></label>}</For></fieldset><p class="muted">Saved only on this device. Reduced-motion settings are respected automatically; no external fonts or analytics are loaded.</p></section></>
}
