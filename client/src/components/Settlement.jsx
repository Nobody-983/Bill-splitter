import { useState } from 'react'
import { formatNaira } from '../lib/money.js'
import { buildSummary } from '../lib/summary.js'
import Avatar from './Avatar.jsx'
import CopyButton from './CopyButton.jsx'
import { Breakdown } from './YourTotal.jsx'
import { Button, Card } from './ui.jsx'

export default function Settlement({ view, meId, onFinalize, onUnlock, busy }) {
  const [open, setOpen] = useState(null)
  const people = Object.fromEntries(view.participants.map((p) => [p.id, p]))
  const { bill, unclaimed } = view.totals
  const isHost = view.viewer.isHost
  const locked = view.table.finalized

  return (
    <Card data-testid="settlement">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Who owes what</h2>
        {locked && <span className="rounded-full bg-brand px-2.5 py-1 text-xs font-bold text-white">Final</span>}
      </div>

      {view.totals.participants.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nobody has joined yet. Totals appear here as people tap their items.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {view.totals.participants.map((row) => {
            const person = people[row.participantId]
            const isOpen = open === row.participantId
            return (
              <li key={row.participantId}>
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center gap-3 py-2 text-left"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : row.participantId)}
                >
                  <Avatar person={person} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {person.name}
                      {row.participantId === meId && <span className="ml-1.5 text-xs font-medium text-brand">(you)</span>}
                    </span>
                    <span className="text-xs text-muted">
                      {row.itemCount ? `${row.itemCount} ${row.itemCount === 1 ? 'item' : 'items'} · tap for details` : 'Hasn’t tapped anything yet'}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-lg font-bold" data-testid="settle-amount">
                    {formatNaira(row.total)}
                  </span>
                </button>
                {isOpen && (
                  <div className="pb-3 pl-11">
                    <Breakdown row={row} taxPercent={view.table.taxPercent} tipPercent={view.table.tipPercent} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <dl className="tabular mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-xl bg-stone-50 p-3 text-sm">
        <dt className="text-muted">Items</dt>
        <dd className="text-right">{formatNaira(bill.subtotal)}</dd>
        <dt className="text-muted">Tax ({view.table.taxPercent}%)</dt>
        <dd className="text-right">{formatNaira(bill.tax)}</dd>
        <dt className="text-muted">Tip ({view.table.tipPercent}%)</dt>
        <dd className="text-right">{formatNaira(bill.tip)}</dd>
        {unclaimed.count > 0 && (
          <>
            <dt className="font-semibold text-alert">Unclaimed ({unclaimed.count})</dt>
            <dd className="text-right font-semibold text-alert">{formatNaira(unclaimed.total)}</dd>
          </>
        )}
        <dt className="pt-1 text-base font-bold">Total bill</dt>
        <dd className="pt-1 text-right text-base font-bold" data-testid="bill-total">
          {formatNaira(bill.total)}
        </dd>
      </dl>

      {isHost && (
        <div className="mt-4 rounded-xl border border-line p-3">
          {locked ? (
            <>
              <p className="text-sm text-muted">The bill is final. Nobody can change items or claims.</p>
              <Button variant="secondary" className="mt-2 w-full" busy={busy === 'unlock'} onClick={onUnlock}>
                🔓 Unlock to make changes
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">
                {unclaimed.count > 0
                  ? `Everyone done? ${unclaimed.count} ${unclaimed.count === 1 ? 'item is' : 'items are'} still unclaimed — they won’t be in anyone’s total.`
                  : 'Everyone done? Finalizing locks items and claims so the totals stop changing.'}
              </p>
              <Button className="mt-2 w-full" busy={busy === 'finalize'} disabled={view.items.length === 0} onClick={onFinalize}>
                ✓ Finalize bill
              </Button>
            </>
          )}
        </div>
      )}

      <CopyButton
        text={() => buildSummary(view)}
        label="Copy summary for the group chat"
        variant={isHost ? 'primary' : 'secondary'}
        className="mt-3 w-full"
      />
    </Card>
  )
}
