import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createPool } from '../src/db.js'
import { migrate } from '../src/migrate.js'

const url = process.env.TEST_DATABASE_URL
if (!url || !/test/.test(new URL(url).pathname)) {
  throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test" (it gets wiped).')
}

let pool, server, base

before(async () => {
  pool = createPool(url)
  await migrate(pool, () => {})
  server = createApp(pool, { rateLimits: false, serveClient: false }).listen(0)
  base = `http://localhost:${server.address().port}/api`
})
beforeEach(() => pool.query('TRUNCATE bill_tables CASCADE'))
after(async () => {
  server.close()
  await pool.end()
})

async function call(method, path, { body, host, token, raw } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (host) headers['x-host-key'] = host
  if (token) headers['x-participant-token'] = token
  const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) })
  return { status: res.status, data: await res.json() }
}

async function setup() {
  const t = await call('POST', '/tables', { body: { name: 'Friday', taxPercent: '7.5', tipPercent: '10' } })
  const id = t.data.table.id
  const host = t.data.hostKey
  const add = async (name, price) => (await call('POST', `/tables/${id}/items`, { host, body: { name, price } })).data.item.id
  const join = async (name, token) => (await call('POST', `/tables/${id}/participants`, { body: { name }, token })).data
  return { id, host, add, join }
}

test('health reports database up', async () => {
  const r = await call('GET', '/health')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { ok: true, database: 'up' })
})

test('create validates input and never leaks the host key on reads', async () => {
  assert.equal((await call('POST', '/tables', { body: { taxPercent: '60' } })).status, 400)
  assert.equal((await call('POST', '/tables', { body: { tipPercent: 'lots' } })).status, 400)
  assert.equal((await call('POST', '/tables', { body: { name: '   ' } })).status, 400)
  const { id } = await setup()
  assert.match(id, /^[a-hjkmnp-z2-9]{6}$/)
  const r = await call('GET', `/tables/${id}`)
  assert.equal(r.status, 200)
  assert.equal(r.data.viewer.isHost, false)
  assert.ok(!JSON.stringify(r.data).match(/hostKey|host_key|token_hash/))
})

test('only the host can edit; invalid prices and missing records are rejected', async () => {
  const { id, host, add } = await setup()
  assert.equal((await call('POST', `/tables/${id}/items`, { body: { name: 'Rice', price: '100' } })).status, 403)
  assert.equal((await call('POST', `/tables/${id}/items`, { host: 'wrong', body: { name: 'Rice', price: '100' } })).status, 403)
  for (const price of ['-1', '0', '12.345', 'free', 1e12]) {
    assert.equal((await call('POST', `/tables/${id}/items`, { host, body: { name: 'Rice', price } })).status, 400, `price ${price}`)
  }
  assert.equal((await call('POST', `/tables/${id}/items`, { host, body: { price: '100' } })).status, 400)
  const itemId = await add('Rice', '4500.50')
  const edited = await call('PATCH', `/tables/${id}/items/${itemId}`, { host, body: { price: '4600' } })
  assert.equal(edited.data.items[0].priceKobo, 460000)
  assert.equal((await call('PATCH', `/tables/${id}/items/999999`, { host, body: { price: '1' } })).status, 404)
  assert.equal((await call('GET', '/tables/zzzzzz')).status, 404)
  assert.equal((await call('GET', '/tables/not-a-code')).status, 404)
  assert.equal((await call('PATCH', `/tables/${id}`, { host, body: { taxPercent: '51' } })).status, 400)
  assert.equal((await call('PATCH', `/tables/${id}`, { host, body: { tipPercent: '12.5' } })).data.table.tipPercent, '12.5')
})

test('joining: case-insensitive unique names, idempotent rejoin with same token', async () => {
  const { id, join } = await setup()
  const ada = await join('Ada')
  assert.ok(ada.participantToken)
  assert.equal((await call('POST', `/tables/${id}/participants`, { body: { name: 'ADA ' } })).status, 409)
  const again = await call('POST', `/tables/${id}/participants`, { body: { name: 'Whatever' }, token: ada.participantToken })
  assert.equal(again.status, 200)
  assert.equal(again.data.participant.id, ada.participant.id)
  assert.equal(again.data.participants.length, 1)
  assert.equal(again.data.viewer.participantId, ada.participant.id)
})

test('full flow: shared items, idempotent claims, unclaimed tracking, reconciled totals', async () => {
  const { id, host, add, join } = await setup()
  const pizza = await add('Pizza', '9000')
  const rice = await add('Rice', '4000')
  const zobo = await add('Zobo', '1500')
  const a = await join('Ada')
  const b = await join('Bayo')
  const c = await join('Chi')

  let v = (await call('GET', `/tables/${id}`)).data
  assert.deepEqual(v.unclaimedItemIds, [pizza, rice, zobo])

  for (const p of [a, b, c]) await call('POST', `/tables/${id}/claim`, { token: p.participantToken, body: { itemId: pizza, claimed: true } })
  // double-click / retry: same claim twice must not duplicate
  await call('POST', `/tables/${id}/claim`, { token: a.participantToken, body: { itemId: rice, claimed: true } })
  v = (await call('POST', `/tables/${id}/claim`, { token: a.participantToken, body: { itemId: rice, claimed: true } })).data

  assert.deepEqual(v.items.find((i) => i.id === rice).claimedBy, [a.participant.id])
  assert.deepEqual(v.unclaimedItemIds, [zobo])
  const byId = Object.fromEntries(v.totals.participants.map((p) => [p.participantId, p]))
  assert.equal(byId[b.participant.id].subtotal, 300000) // ₦3,000 share of the pizza
  assert.equal(byId[a.participant.id].subtotal, 700000) // pizza share + rice
  assert.equal(byId[a.participant.id].tax, 52500) // 7.5% of ₦7,000
  assert.equal(byId[a.participant.id].tip, 70000) // 10% of ₦7,000
  const owed = v.totals.participants.reduce((s, p) => s + p.total, 0)
  assert.equal(owed + v.totals.unclaimed.total, v.totals.bill.total)
  assert.equal(v.totals.unclaimed.subtotal, 150000)

  v = (await call('POST', `/tables/${id}/claim`, { token: c.participantToken, body: { itemId: zobo, claimed: true } })).data
  assert.deepEqual(v.unclaimedItemIds, [])
  v = (await call('POST', `/tables/${id}/claim`, { token: c.participantToken, body: { itemId: zobo, claimed: false } })).data
  assert.deepEqual(v.unclaimedItemIds, [zobo])
  v = (await call('POST', `/tables/${id}/claim`, { token: c.participantToken, body: { itemId: zobo, claimed: false } })).data
  assert.deepEqual(v.unclaimedItemIds, [zobo]) // removing twice is fine

  // claims need a valid participant token, a real item, and a boolean
  assert.equal((await call('POST', `/tables/${id}/claim`, { body: { itemId: zobo, claimed: true } })).status, 403)
  assert.equal((await call('POST', `/tables/${id}/claim`, { token: a.participantToken, body: { itemId: '424242', claimed: true } })).status, 404)
  assert.equal((await call('POST', `/tables/${id}/claim`, { token: a.participantToken, body: { itemId: zobo, claimed: 'yes' } })).status, 400)

  // deleting an item removes its claims
  v = (await call('DELETE', `/tables/${id}/items/${pizza}`, { host })).data
  assert.equal(v.totals.participants.find((p) => p.participantId === b.participant.id).total, 0)
})

test('finalize locks items and claims; unlock reopens; only host can do either', async () => {
  const { id, host, add, join } = await setup()
  const rice = await add('Rice', '4000')
  const a = await join('Ada')
  assert.equal((await call('POST', `/tables/${id}/finalize`)).status, 403)
  assert.equal((await call('POST', `/tables/${id}/finalize`, { host })).data.table.finalized, true)
  assert.equal((await call('POST', `/tables/${id}/claim`, { token: a.participantToken, body: { itemId: rice, claimed: true } })).status, 409)
  assert.equal((await call('POST', `/tables/${id}/items`, { host, body: { name: 'X', price: '1' } })).status, 409)
  assert.equal((await call('PATCH', `/tables/${id}`, { host, body: { taxPercent: '5' } })).status, 409)
  assert.equal((await call('POST', `/tables/${id}/unlock`, { host })).data.table.finalized, false)
  assert.equal((await call('POST', `/tables/${id}/claim`, { token: a.participantToken, body: { itemId: rice, claimed: true } })).status, 200)
})

test('sample bill creates real items through the backend', async () => {
  const { id, host } = await setup()
  assert.equal((await call('POST', `/tables/${id}/sample`)).status, 403)
  const r = await call('POST', `/tables/${id}/sample`, { host })
  assert.equal(r.status, 201)
  assert.ok(r.data.items.length >= 5)
  assert.equal(r.data.unclaimedItemIds.length, r.data.items.length)
})

test('concurrent claims and a racing finalize never error or duplicate', async () => {
  const { id, host, add, join } = await setup()
  const pizza = await add('Pizza', '9000')
  const people = []
  for (let i = 0; i < 12; i++) people.push(await join(`P${i}`))
  const claimAll = people.flatMap((p) =>
    [1, 2].map(() => call('POST', `/tables/${id}/claim`, { token: p.participantToken, body: { itemId: pizza, claimed: true } })),
  )
  const results = await Promise.all([...claimAll, call('POST', `/tables/${id}/finalize`, { host })])
  for (const r of results) assert.ok([200, 409].includes(r.status), `unexpected ${r.status} ${JSON.stringify(r.data)}`)
  const v = (await call('GET', `/tables/${id}`)).data
  const claimers = v.items[0].claimedBy
  assert.equal(new Set(claimers).size, claimers.length) // no duplicates
  const owed = v.totals.participants.reduce((s, p) => s + p.total, 0)
  assert.equal(owed + v.totals.unclaimed.total, v.totals.bill.total)
})

test('malformed and oversized bodies get clean JSON errors', async () => {
  const { id } = await setup()
  const bad = await call('POST', `/tables/${id}/participants`, { raw: '{"name":' })
  assert.equal(bad.status, 400)
  assert.equal(bad.data.error.code, 'invalid_json')
  const big = await call('POST', `/tables/${id}/participants`, { raw: JSON.stringify({ name: 'x'.repeat(20_000) }) })
  assert.equal(big.status, 413)
  assert.equal((await call('GET', '/nope')).status, 404)
})
