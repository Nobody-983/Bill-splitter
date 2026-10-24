import { formatNaira } from './money.js'

// Builds the host's copyable settlement text from server-calculated totals.
export function buildSummary(view) {
  const names = Object.fromEntries(view.participants.map((p) => [p.id, p.name]))
  const lines = ['Tab — Bill Summary', view.table.name]
  for (const p of view.totals.participants) lines.push(`- ${names[p.participantId]}: ${formatNaira(p.total)}`)
  lines.push(`- Unclaimed items: ${view.totals.unclaimed.count}${view.totals.unclaimed.count ? ` (${formatNaira(view.totals.unclaimed.total)})` : ''}`)
  lines.push(`- Total bill: ${formatNaira(view.totals.bill.total)}`)
  return lines.join('\n')
}
