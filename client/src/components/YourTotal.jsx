import { useState } from 'react'
import { formatNaira } from '../lib/money.js'

export function Breakdown({ row, taxPercent, tipPercent }) {
  return (
    <dl className="tabular grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted">Your items ({row.itemCount})</dt>
      <dd className="text-right">{formatNaira(row.subtotal)}</dd>
      <dt className="text-muted">Tax ({taxPercent}%)</dt>
      <dd className="text-right">{formatNaira(row.tax)}</dd>
      <dt className="text-muted">Tip ({tipPercent}%)</dt>
      <dd className="text-right">{formatNaira(row.tip)}</dd>
      <div className="col-span-2 my-0.5 border-t border-line" role="presentation" />
      <dt className="font-semibold">Total</dt>
      <dd className="text-right font-semibold">{formatNaira(row.total)}</dd>
    </dl>
  )
}

// Mobile: sticky bottom bar that expands into a breakdown. Desktop: a regular card.
export default function YourTotal({ view, meId }) {
  const [open, setOpen] = useState(false)
  const row = view.totals.participants.find((p) => p.participantId === meId)
  if (!row) return null
  const empty = row.itemCount === 0
  const props = { row, taxPercent: view.table.taxPercent, tipPercent: view.table.tipPercent }

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.25)] lg:hidden">
        {open && !empty && (
          <div className="border-b border-line px-4 pb-3 pt-4" id="total-breakdown">
            <Breakdown {...props} />
          </div>
        )}
        <button
          type="button"
          onClick={() => !empty && setOpen(!open)}
          aria-expanded={empty ? undefined : open}
          aria-controls="total-breakdown"
          className="flex w-full items-center justify-between gap-4 px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3 text-left"
        >
          <span>
            <span className="block text-xs font-semibold uppercase tracking-wide text-muted">You owe</span>
            <span className="tabular block text-2xl font-extrabold" data-testid="my-total">
              {formatNaira(row.total)}
            </span>
          </span>
          <span className="text-right text-sm text-muted">
            {empty ? (
              'Tap the items you had ↑'
            ) : (
              <>
                {row.itemCount} {row.itemCount === 1 ? 'item' : 'items'} incl. tax & tip
                <span className="block font-semibold text-brand">{open ? 'Hide details ▾' : 'See breakdown ▴'}</span>
              </>
            )}
          </span>
        </button>
      </div>

      <section className="hidden rounded-2xl bg-white p-5 shadow-sm ring-2 ring-brand lg:block">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">You owe</p>
        <p className="tabular text-3xl font-extrabold">{formatNaira(row.total)}</p>
        <div className="mt-3">{empty ? <p className="text-sm text-muted">Tap the items you had.</p> : <Breakdown {...props} />}</div>
      </section>
    </>
  )
}
