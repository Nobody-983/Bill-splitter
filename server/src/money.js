// All money math for Tab. Amounts are integer kobo (₦1 = 100 kobo) and are
// computed with BigInt, so no floating-point value ever touches money.
// Percentages are stored as basis points (7.5% = 750 bp).
//
// Rounding policy (documented in README):
//  1. A shared item's price is split equally among its claimants with the
//     largest-remainder method; leftover kobo go to the earliest claimants.
//  2. Tax and tip are each rounded ONCE (half-up, to the kobo) on the claimed
//     subtotal, then split across participants in proportion to their
//     subtotals with largest remainder (ties → earlier participant).
//  3. Bill-wide tax/tip are rounded once on the full bill subtotal; the
//     unclaimed portion is bill total minus claimed portion, so
//     sum(everyone's total) + unclaimed total === bill total, exactly.

export const MAX_PRICE_KOBO = 10_000_000_000n // ₦100,000,000.00 per item
export const MAX_TAX_BP = 5000 // 50%
export const MAX_TIP_BP = 10000 // 100%

// "4500" | "4,500.50" | 4500.5 → 450050n. Returns null when invalid.
export function parseNairaToKobo(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim().replace(/,/g, '')
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return null
  const kobo = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  if (kobo <= 0n || kobo > MAX_PRICE_KOBO) return null
  return kobo
}

// "7.5" | 7.5 → 750. Returns null when invalid or above `max` bp.
export function parsePercentToBp(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(value).trim())
  if (!match) return null
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return bp <= max ? bp : null
}

export function bpToPercentString(bp) {
  const whole = Math.floor(bp / 100)
  const frac = bp % 100
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`
}

// round(amount × bp / 10000), half-up. amount: BigInt ≥ 0.
export function applyRate(amount, bp) {
  return (amount * BigInt(bp) + 5000n) / 10000n
}

// Split `total` into parts proportional to `weights` (BigInt[]), summing to
// exactly `total`. Leftover units go to the largest fractional remainders;
// ties go to the lower index (the earlier claimant/participant).
export function largestRemainder(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0n)
  if (sum === 0n) return weights.map(() => 0n)
  const shares = weights.map((w) => (total * w) / sum)
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % sum }))
  let left = total - shares.reduce((a, s) => a + s, 0n)
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i))
  for (const { i } of remainders) {
    if (left === 0n) break
    shares[i] += 1n
    left -= 1n
  }
  return shares
}

/**
 * Computes every amount the UI shows.
 * @param {{taxBp:number, tipBp:number}} rates
 * @param {{id:string, priceKobo:bigint}[]} items
 * @param {{id:string}[]} participants  in join order
 * @param {{itemId:string, participantId:string}[]} claims  in claim order
 */
export function computeTotals({ taxBp, tipBp }, items, participants, claims) {
  const subtotal = new Map(participants.map((p) => [p.id, 0n]))
  const itemCount = new Map(participants.map((p) => [p.id, 0]))
  let claimedSubtotal = 0n
  let unclaimedSubtotal = 0n
  const unclaimedItemIds = []
  const itemShares = {}

  for (const item of items) {
    const claimants = claims.filter((c) => c.itemId === item.id && subtotal.has(c.participantId)).map((c) => c.participantId)
    if (claimants.length === 0) {
      unclaimedSubtotal += item.priceKobo
      unclaimedItemIds.push(item.id)
      continue
    }
    claimedSubtotal += item.priceKobo
    const parts = largestRemainder(item.priceKobo, claimants.map(() => 1n))
    itemShares[item.id] = {}
    claimants.forEach((pid, i) => {
      subtotal.set(pid, subtotal.get(pid) + parts[i])
      itemCount.set(pid, itemCount.get(pid) + 1)
      itemShares[item.id][pid] = parts[i]
    })
  }

  const ids = participants.map((p) => p.id)
  const weights = ids.map((id) => subtotal.get(id))
  const claimedTax = applyRate(claimedSubtotal, taxBp)
  const claimedTip = applyRate(claimedSubtotal, tipBp)
  const taxParts = largestRemainder(claimedTax, weights)
  const tipParts = largestRemainder(claimedTip, weights)

  const billSubtotal = claimedSubtotal + unclaimedSubtotal
  const billTax = applyRate(billSubtotal, taxBp)
  const billTip = applyRate(billSubtotal, tipBp)

  const people = ids.map((id, i) => ({
    participantId: id,
    itemCount: itemCount.get(id),
    subtotal: weights[i],
    tax: taxParts[i],
    tip: tipParts[i],
    total: weights[i] + taxParts[i] + tipParts[i],
  }))
  const claimedTotal = claimedSubtotal + claimedTax + claimedTip
  const billTotal = billSubtotal + billTax + billTip

  return {
    participants: people,
    itemShares,
    unclaimedItemIds,
    claimed: { subtotal: claimedSubtotal, tax: claimedTax, tip: claimedTip, total: claimedTotal },
    unclaimed: {
      count: unclaimedItemIds.length,
      subtotal: unclaimedSubtotal,
      tax: billTax - claimedTax,
      tip: billTip - claimedTip,
      total: billTotal - claimedTotal,
    },
    bill: { subtotal: billSubtotal, tax: billTax, tip: billTip, total: billTotal },
  }
}

// Deep-convert BigInt → Number for JSON. Safe: amounts are capped far below 2^53.
export function toJSONSafe(value) {
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJSONSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJSONSafe(v)]))
  return value
}
