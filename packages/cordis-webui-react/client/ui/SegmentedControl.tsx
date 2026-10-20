// Vendored from deepseek-harness `packages/client/ui-primitives/src/SegmentedControl.tsx`.
// SegmentedControl: a tablist of two or more equal-width segments with one
// sliding indicator, for switching a card or panel between a few modes. The
// owner holds the selection; `label` is required so the tablist never ships
// without an accessible name, and every segment label is owner-localized.

import { useEffect, useRef } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import clsx from 'clsx'
import css from './SegmentedControl.module.css'

export interface SegmentedControlOption<Value extends string> {
  value: Value
  label: string
  disabled?: boolean
  title?: string
}

type WalkKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'

function isWalkKey(key: string): key is WalkKey {
  return (
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Home' ||
    key === 'End'
  )
}

function walk<Value extends string>(
  options: readonly SegmentedControlOption<Value>[],
  from: number,
  key: WalkKey,
): SegmentedControlOption<Value> | undefined {
  const enabled = options.filter((option) => option.disabled !== true)
  if (key === 'Home') return enabled[0]
  if (key === 'End') return enabled[enabled.length - 1]
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
  const count = options.length
  for (let offset = 1; offset < count; offset += 1) {
    const candidate =
      options[(((from + step * offset) % count) + count) % count]
    if (candidate !== undefined && candidate.disabled !== true) return candidate
  }
  return undefined
}

export function SegmentedControl<Value extends string>({
  id,
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
}: {
  id: string
  value: Value
  options: readonly SegmentedControlOption<Value>[]
  onChange: (next: Value) => void
  label: string
  disabled?: boolean
  className?: string | undefined
}) {
  const list = useRef<HTMLDivElement>(null)
  const selected = options.findIndex((option) => option.value === value)
  useEffect(() => {
    const root = list.current
    if (root === null) return
    if (!root.contains(document.activeElement)) return
    root
      .querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.focus()
  }, [value])
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!isWalkKey(event.key)) return
    event.preventDefault()
    const target = walk(options, selected, event.key)
    if (target !== undefined && target.value !== value) onChange(target.value)
  }
  const indicator = {
    '--dsh-segment-count': String(options.length),
    '--dsh-segment-index': String(selected),
  } as CSSProperties
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={clsx(css.control, className)}
      style={indicator}
    >
      <span aria-hidden="true" className={css.indicator} />
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            id={`${id}-${option.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${id}-${option.value}-panel`}
            tabIndex={active ? 0 : -1}
            disabled={disabled || option.disabled === true}
            title={option.title}
            className={css.tab}
            onClick={() => {
              if (!active) onChange(option.value)
            }}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
