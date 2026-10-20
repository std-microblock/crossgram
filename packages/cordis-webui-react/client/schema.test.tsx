import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import z from 'schemastery'
import { SchemaForm } from './schema.js'
afterEach(() => cleanup())
function mount(schema: any, value: any, onSave = vi.fn(async () => {})) {
  let setCurrent: (value: any) => void = () => {}
  function Harness() {
    const [current, setValue] = useState(value)
    setCurrent = setValue
    return (
      <SchemaForm
        schema={JSON.parse(JSON.stringify(schema))}
        value={current}
        onSave={onSave}
      />
    )
  }
  const { container: root } = render(<Harness />)
  return {
    root,
    onSave,
    setCurrent: (next: any) => act(() => setCurrent(next)),
  }
}
function field(label: string) {
  return screen.getByLabelText(label, {
    // Required fields render a trailing `*` inside the label element.
    exact: false,
    selector: 'input,textarea,select',
  }) as HTMLInputElement
}
function input(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  fireEvent.change(element, { target: { value } })
}
function button(root: HTMLElement, text: string) {
  return Array.from(root.querySelectorAll('button')).find(
    (node) => node.textContent === text,
  )!
}
function click(root: HTMLElement, text: string) {
  fireEvent.click(button(root, text))
}
function save(root: HTMLElement) {
  fireEvent.submit(root.querySelector('form')!)
}
describe('Schemastery React form', () => {
  it('edits controls, preserves hidden config, masks secrets, and submits typed data', async () => {
    const { root, onSave } = mount(
      z.object({
        host: z.string(),
        port: z.natural(),
        token: z.string().role('secret'),
        hidden: z.string().hidden(),
        enabled: z.boolean(),
      }),
      { host: 'old', port: 80, token: 'secret', hidden: 'keep', enabled: true },
    )
    expect(root.textContent).not.toContain('Hidden')
    expect(field('Token').type).toBe('password')
    click(root, 'Reveal')
    expect(field('Token').type).toBe('text')
    input(field('Host'), 'new')
    input(field('Port'), '443')
    expect(button(root, 'Save changes').disabled).toBe(false)
    save(root)
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        host: 'new',
        port: 443,
        token: 'secret',
        hidden: 'keep',
        enabled: true,
      }),
    )
    await vi.waitFor(() =>
      expect(root.textContent).toContain('Configuration saved'),
    )
  })
  it('blocks invalid numeric values and malformed JSON without losing the draft', async () => {
    const { root, onSave } = mount(
      z.object({ port: z.natural().min(1).max(100) }),
      { port: 10 },
    )
    input(field('Port'), '101')
    expect(root.textContent).toContain('Maximum is 100')
    save(root)
    expect(onSave).not.toHaveBeenCalled()
    input(field('Port'), '20')
    click(root, 'Edit JSON')
    input(root.querySelector('textarea')!, '{')
    expect(button(root, 'Save changes').disabled).toBe(true)
    input(root.querySelector('textarea')!, '{"port":25}')
    save(root)
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ port: 25 }))
  })
  it('handles arrays, dictionaries, unions, nested defaults and disabled fields', () => {
    const { root } = mount(
      z.object({
        names: z.array(String),
        options: z.dict(Number),
        choice: z.union(['a', 'b']),
        locked: z.string().disabled(),
      }),
      { names: ['one'], options: {}, choice: 'a', locked: 'fixed' },
    )
    click(root, 'Add item')
    expect(
      root.querySelectorAll('[aria-label^="Remove Names item"]'),
    ).toHaveLength(2)
    expect(field('Locked').disabled).toBe(true)
    input(screen.getByLabelText('Options new key') as HTMLInputElement, 'limit')
    click(root, 'Add entry')
    expect(field('Limit').value).toBe('0')
    const select = field('Choice')
    input(select, '1')
    expect(select.value).toBe('1')
    click(root, 'Discard changes')
    expect(
      root.querySelectorAll('[aria-label^="Remove Names item"]'),
    ).toHaveLength(1)
  })
  it('detects concurrent server edits and requires reloading before saving', () => {
    const { root, setCurrent, onSave } = mount(z.object({ host: z.string() }), {
      host: 'old',
    })
    input(field('Host'), 'local')
    setCurrent({ host: 'remote' })
    expect(root.textContent).toContain('Configuration changed on the server')
    save(root)
    expect(onSave).not.toHaveBeenCalled()
    click(root, 'Reload configuration')
    expect(field('Host').value).toBe('remote')
    expect(button(root, 'Save changes').disabled).toBe(true)
  })
  it('surfaces server validation errors and keeps edits for correction', async () => {
    const { root } = mount(
      z.object({ host: z.string() }),
      { host: 'old' },
      vi.fn(async () => {
        throw new Error('Rejected by plugin')
      }),
    )
    input(field('Host'), 'new')
    save(root)
    await vi.waitFor(() =>
      expect(root.textContent).toContain('Rejected by plugin'),
    )
    expect(field('Host').value).toBe('new')
    expect(button(root, 'Save changes').disabled).toBe(false)
  })
})
