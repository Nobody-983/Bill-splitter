import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRate,
  computeTotals,
  largestRemainder,
  parseNairaToKobo,
  parsePercentToBp,
  MAX_TAX_BP,
} from '../src/money.js'

test('parseNairaToKobo accepts naira strings and numbers, rejects junk', () => {
  assert.equal(parseNairaToKobo('4500'), 450000n)
  assert.equal(parseNairaToKobo('4,500.5'), 450050n)
  assert.equal(parseNairaToKobo(4500.25), 450025n)
  assert.equal(parseNairaToKobo('0.01'), 1n)
  for (const bad of ['0', '-5', '1.234', 'abc', '', '1e5', null, undefined, {}, '100000000.01']) {
    assert.equal(parseNairaToKobo(bad), null, `should reject ${JSON.stringify(bad)}`)
  }
})

test('parsePercentToBp validates range and precision', () => {
  assert.equal(parsePercentToBp('7.5', MAX_TAX_BP), 750)
  assert.equal(parsePercentToBp(0, MAX_TAX_BP), 0)
  assert.equal(parsePercentToBp('50', MAX_TAX_BP), 5000)
  assert.equal(parsePercentToBp('50.01', MAX_TAX_BP), null)
  assert.equal(parsePercentToBp('-1', MAX_TAX_BP), null)
  assert.equal(parsePercentToBp('7.555', MAX_TAX_BP), null)
})

test('applyRate rounds half up to the kobo', () => {
  assert.equal(applyRate(1000n, 750), 75n) // 7.5% of ₦10.00
  assert.equal(applyRate(10n, 500), 1n) // 0.5 kobo → 1
  assert.equal(applyRate(9n, 500), 0n) // 0.45 kobo → 0
})

test('largestRemainder always sums exactly and favours earlier on ties', () => {
  assert.deepEqual(largestRemainder(10000n, [1n, 1n, 1n]), [3334n, 3333n, 3333n])
  assert.deepEqual(largestRemainder(2n, [1n, 1n, 1n]), [1n, 1n, 0n])
  assert.deepEqual(largestRemainder(0n, [0n, 0n]), [0n, 0n])
  const shares = largestRemainder(99999n, [3n, 7n, 11n, 13n])
  assert.equal(shares.reduce((a, b) => a + b, 0n), 99999n)
})

const P = (...ids) => ids.map((id) => ({ id }))
const I = (id, naira) => ({ id, priceKobo: BigInt(naira) * 100n })

test('three people sharing a ₦9,000 pizza each owe ₦3,000 before tax/tip', () => {
  const t = computeTotals({ taxBp: 0, tipBp: 0 }, [I('pizza', 9000)], P('a', 'b', 'c'), [
    { itemId: 'pizza', participantId: 'a' },
    { itemId: 'pizza', participantId: 'b' },
    { itemId: 'pizza', participantId: 'c' },
  ])
  assert.deepEqual(t.participants.map((p) => p.subtotal), [300000n, 300000n, 300000n])
})

test('tax and tip are proportional to subtotal; no claims means nothing owed', () => {
  const t = computeTotals(
    { taxBp: 750, tipBp: 1000 },
    [I('rice', 4000), I('suya', 6000)],
    P('a', 'b', 'idle'),
    [
      { itemId: 'rice', participantId: 'a' },
      { itemId: 'suya', participantId: 'b' },
    ],
  )
  const [a, b, idle] = t.participants
  assert.equal(a.tax, 30000n) // 7.5% of ₦4,000
  assert.equal(a.tip, 40000n) // 10% of ₦4,000
  assert.equal(b.tax, 45000n)
  assert.equal(b.tip, 60000n)
  assert.deepEqual([idle.subtotal, idle.tax, idle.tip, idle.total], [0n, 0n, 0n, 0n])
})

test('unclaimed items are excluded from people and everything reconciles to the bill', () => {
  const t = computeTotals(
    { taxBp: 750, tipBp: 1250 },
    [I('pizza', 9001), I('drink', 1333), I('nobody', 2777)],
    P('a', 'b', 'c'),
    [
      { itemId: 'pizza', participantId: 'a' },
      { itemId: 'pizza', participantId: 'b' },
      { itemId: 'pizza', participantId: 'c' },
      { itemId: 'drink', participantId: 'b' },
    ],
  )
  assert.deepEqual(t.unclaimedItemIds, ['nobody'])
  assert.equal(t.unclaimed.subtotal, 277700n)
  const owed = t.participants.reduce((s, p) => s + p.total, 0n)
  assert.equal(owed, t.claimed.total)
  assert.equal(owed + t.unclaimed.total, t.bill.total)
  assert.equal(t.claimed.subtotal + t.unclaimed.subtotal, t.bill.subtotal)
})

test('awkward amounts still reconcile exactly (randomised)', () => {
  let seed = 42
  const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
  for (let run = 0; run < 300; run++) {
    const people = P(...Array.from({ length: 1 + rand(6) }, (_, i) => `p${i}`))
    const items = Array.from({ length: 1 + rand(8) }, (_, i) => ({ id: `i${i}`, priceKobo: BigInt(1 + rand(5_000_000)) }))
    const claims = []
    for (const it of items) for (const p of people) if (rand(3) === 0) claims.push({ itemId: it.id, participantId: p.id })
    const t = computeTotals({ taxBp: rand(5001), tipBp: rand(10001) }, items, people, claims)
    const owed = t.participants.reduce((s, p) => s + p.total, 0n)
    assert.equal(owed, t.claimed.total)
    assert.equal(owed + t.unclaimed.total, t.bill.total)
    for (const p of t.participants) assert.ok(p.tax >= 0n && p.tip >= 0n && (p.subtotal > 0n || p.total === 0n))
  }
})
