import { useRef, useState } from 'react'
import { formatNaira } from '../lib/money.js'
import { Button, Field, inputClass } from './ui.jsx'

// Kobo → editable naira text: 450050 → "4500.50", 450000 → "4500".
const nairaText = (kobo) => (kobo % 100 ? (kobo / 100).toFixed(2) : String(kobo / 100))

// Fields show live server data, switching to a local draft only while being edited.
function ItemEditRow({ item, run }) {
  const [draft, setDraft] = useState(null)
  const name = draft ? draft.name : item.name
  const price = draft ? draft.price : nairaText(item.priceKobo)
  const startEdit = () => setDraft((d) => d ?? { name: item.name, price: nairaText(item.priceKobo) })
  const edit = (field) => (e) => setDraft((d) => ({ ...d, [field]: e.target.value }))
  const blurOnEnter = (e) => e.key === 'Enter' && e.currentTarget.blur()

  async function save(e) {
    if (e.currentTarget.closest('li').contains(e.relatedTarget)) return // moving between this row's fields
    const patch = {}
    if (name.trim() !== item.name) patch.name = name
    if (price.trim() !== nairaText(item.priceKobo)) patch.price = price.trim()
    if (Object.keys(patch).length) await run((api, id) => api.updateItem(id, item.id, patch), 'Item updated')
    setDraft(null)
  }

  async function remove() {
    const n = item.claimedBy.length
    if (n && !window.confirm(`Remove “${item.name}”? ${n} ${n === 1 ? 'person has' : 'people have'} claimed it.`)) return
    await run((api, id) => api.deleteItem(id, item.id), `Removed ${item.name}`)
  }

  return (
    <li className="grid grid-cols-[1fr_auto] gap-2 rounded-2xl bg-white p-2.5 ring-1 ring-line sm:grid-cols-[1fr_8rem_auto]" data-testid="edit-item">
      <input
        className={`${inputClass} col-span-2 sm:col-span-1`}
        aria-label="Item name"
        value={name}
        onFocus={startEdit}
        onChange={edit('name')}
        onBlur={save}
        onKeyDown={blurOnEnter}
        maxLength={60}
      />
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">₦</span>
        <input
          className={`${inputClass} tabular pl-7 text-right`}
          aria-label={`Price of ${item.name}`}
          inputMode="decimal"
          value={price}
          onFocus={startEdit}
          onChange={edit('price')}
          onBlur={save}
          onKeyDown={blurOnEnter}
        />
      </div>
      <Button variant="danger" className="px-3" aria-label={`Remove ${item.name}`} onClick={remove}>
        Remove
      </Button>
    </li>
  )
}

function RateInput({ label, value, field, run, inputRef }) {
  const [draft, setDraft] = useState(null)
  return (
    <Field label={label}>
      <div className="relative">
        <input
          ref={inputRef}
          className={`${inputClass} pr-8`}
          inputMode="decimal"
          value={draft ?? value}
          onFocus={() => setDraft(value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={async () => {
            if (draft !== null && draft.trim() !== value) await run((api, id) => api.updateTable(id, { [field]: draft.trim() }), `${label} updated`)
            setDraft(null) // on failure the error toast shows and the field reverts to the saved value
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted">%</span>
      </div>
    </Field>
  )
}

export default function BillEditor({ view, run, taxRef }) {
  const [newItem, setNewItem] = useState({ name: '', price: '' })
  const [busy, setBusy] = useState('')
  const nameRef = useRef(null)
  const empty = view.items.length === 0

  async function add(e) {
    e.preventDefault()
    setBusy('add')
    const ok = await run((api, id) => api.addItem(id, { name: newItem.name, price: newItem.price.trim() }), `Added ${newItem.name.trim()}`)
    if (ok) {
      setNewItem({ name: '', price: '' })
      nameRef.current?.focus() // ready for the next item
    }
    setBusy('')
  }

  async function sample() {
    setBusy('sample')
    await run((api, id) => api.loadSample(id), 'Sample bill added')
    setBusy('')
  }

  return (
    <div className="flex flex-col gap-4" data-testid="host-editor">
      <form onSubmit={add} className="rounded-2xl bg-white p-3 ring-2 ring-brand/30">
        <p className="mb-2 text-sm font-semibold">{empty ? 'Add the first item from the bill' : 'Add another item'}</p>
        <div className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_8rem_auto]">
          <input
            ref={nameRef}
            className={`${inputClass} col-span-2 sm:col-span-1`}
            placeholder="Item, e.g. Jollof rice"
            aria-label="New item name"
            value={newItem.name}
            onChange={(e) => setNewItem((n) => ({ ...n, name: e.target.value }))}
            maxLength={60}
            required
            autoFocus={empty}
            enterKeyHint="next"
          />
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">₦</span>
            <input
              className={`${inputClass} tabular pl-7 text-right`}
              placeholder="Price"
              aria-label="New item price"
              inputMode="decimal"
              value={newItem.price}
              onChange={(e) => setNewItem((n) => ({ ...n, price: e.target.value }))}
              required
              enterKeyHint="done"
            />
          </div>
          <Button type="submit" busy={busy === 'add'} className="px-5">
            Add
          </Button>
        </div>
        {empty && (
          <p className="mt-3 text-sm text-muted">
            Just trying it out?{' '}
            <button type="button" onClick={sample} disabled={!!busy} className="font-semibold text-brand underline underline-offset-2">
              {busy === 'sample' ? 'Adding…' : 'Load sample bill'}
            </button>
          </p>
        )}
      </form>

      {!empty && (
        <div>
          <p className="mb-2 text-sm text-muted">
            {view.items.length} {view.items.length === 1 ? 'item' : 'items'} · {formatNaira(view.totals.bill.subtotal)} before tax & tip. Tap a name or price to change it.
          </p>
          <ul className="flex flex-col gap-2">
            {view.items.map((item) => (
              <ItemEditRow key={item.id} item={item} run={run} />
            ))}
          </ul>
          <button type="button" onClick={sample} disabled={!!busy} className="mt-2 min-h-10 text-sm font-medium text-muted underline underline-offset-2">
            {busy === 'sample' ? 'Adding…' : 'Load sample bill'}
          </button>
        </div>
      )}

      <div className="rounded-2xl bg-white p-3 ring-1 ring-line">
        <p className="mb-2 text-sm font-semibold">Tax & tip</p>
        <div className="grid grid-cols-2 gap-3">
          <RateInput label="Tax" field="taxPercent" value={view.table.taxPercent} run={run} inputRef={taxRef} />
          <RateInput label="Tip" field="tipPercent" value={view.table.tipPercent} run={run} />
        </div>
        <p className="mt-2 text-xs text-muted">Both are % of the items, shared in proportion to what each person had.</p>
      </div>
    </div>
  )
}
