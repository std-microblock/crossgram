import { useId, useState } from 'react'
import type { Appearance, Palette } from '../appearance.js'
import { PageHeader } from '../components.js'
import { SegmentedControl } from '../ui/SegmentedControl.js'
import { useAppearance, setAppearance } from '../use-appearance.js'

const palettes: Palette[] = ['sage', 'ocean', 'rose']
const modes: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'Follow your device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]
export default function SettingsPage() {
  const current = useAppearance()
  const [pending, setPending] = useState<{
    appearance: Appearance
    palette: Palette
  }>()
  const selected = pending ?? current
  const baseId = 'appearance' + useId().replaceAll(':', '')
  const update = (appearance: Appearance, palette: Palette) => {
    setPending({ appearance, palette })
    setAppearance(appearance, palette)
  }
  return (
    <>
      <PageHeader
        title="Make yourself at home"
        description="A little more you. A little less noise."
      />
      <section className="panel stack settings-panel">
        <h2>Appearance</h2>
        <SegmentedControl
          id={baseId}
          value={selected.appearance}
          options={modes}
          label="Color mode"
          onChange={(appearance) => update(appearance, selected.palette)}
        />
        <div
          role="tabpanel"
          id={`${baseId}-${selected.appearance}-panel`}
          aria-labelledby={`${baseId}-${selected.appearance}`}
          className="stack"
        >
          <fieldset className="palette-options">
            <legend>Workspace color</legend>
            {palettes.map((color) => (
              <label key={color}>
                <input
                  type="radio"
                  name="palette"
                  value={color}
                  checked={selected.palette === color}
                  onChange={() => update(selected.appearance, color)}
                />
                <span className={'color-sample ' + color} />
                <span>{color}</span>
              </label>
            ))}
          </fieldset>
          <p className="muted">
            Saved only on this device. Reduced-motion settings are respected
            automatically; no external fonts or analytics are loaded.
          </p>
        </div>
      </section>
    </>
  )
}
