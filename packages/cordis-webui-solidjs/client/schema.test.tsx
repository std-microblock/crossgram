/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import z from 'schemastery'
import { SchemaForm } from './schema.js'
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
})
function mount(schema: any, value: any, onSave = vi.fn(async () => {})) {
  const root = document.createElement('div')
  document.body.append(root)
  const [current, setCurrent] = createSignal(value)
  disposers.push(
    render(
      () => (
        <SchemaForm
          schema={JSON.parse(JSON.stringify(schema))}
          value={current()}
          onSave={onSave}
        />
      ),
      root,
    ),
  )
  return { root, onSave, setCurrent }
}
function field(root: HTMLElement, label: string) {
  const element = Array.from(root.querySelectorAll('label')).find(
    (node) => node.textContent?.replace(/\s*\*$/, '') === label,
  )!
  return document.getElementById(element.htmlFor) as HTMLInputElement
}
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
function button(root: HTMLElement, text: string) {
  return Array.from(root.querySelectorAll('button')).find(
    (node) => node.textContent === text,
  )!
}
function save(root: HTMLElement) {
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}
describe('Schemastery Solid form', () => {
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
    expect(field(root, 'Token').type).toBe('password')
    button(root, 'Reveal').click()
    expect(field(root, 'Token').type).toBe('text')
    input(field(root, 'Host'), 'new')
    input(field(root, 'Port'), '443')
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
    input(field(root, 'Port'), '101')
    expect(root.textContent).toContain('Maximum is 100')
    save(root)
    expect(onSave).not.toHaveBeenCalled()
    input(field(root, 'Port'), '20')
    button(root, 'Edit JSON').click()
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
    button(root, 'Add item').click()
    expect(
      root.querySelectorAll('[aria-label^="Remove Names item"]'),
    ).toHaveLength(2)
    expect(field(root, 'Locked').disabled).toBe(true)
    input(
      root.querySelector('[aria-label="Options new key"]') as HTMLInputElement,
      'limit',
    )
    button(root, 'Add entry').click()
    expect(field(root, 'Limit').value).toBe('0')
    const select = root.querySelector('select')!
    select.value = '1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(select.value).toBe('1')
    button(root, 'Discard changes').click()
    expect(
      root.querySelectorAll('[aria-label^="Remove Names item"]'),
    ).toHaveLength(1)
  })
  it('detects concurrent server edits and requires reloading before saving', () => {
    const { root, setCurrent, onSave } = mount(z.object({ host: z.string() }), {
      host: 'old',
    })
    input(field(root, 'Host'), 'local')
    setCurrent({ host: 'remote' })
    expect(root.textContent).toContain('Configuration changed on the server')
    save(root)
    expect(onSave).not.toHaveBeenCalled()
    button(root, 'Reload configuration').click()
    expect(field(root, 'Host').value).toBe('remote')
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
    input(field(root, 'Host'), 'new')
    save(root)
    await vi.waitFor(() =>
      expect(root.textContent).toContain('Rejected by plugin'),
    )
    expect(field(root, 'Host').value).toBe('new')
    expect(button(root, 'Save changes').disabled).toBe(false)
  })
})
