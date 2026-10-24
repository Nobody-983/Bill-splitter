// Data access + business rules for tables. Route handlers stay thin and call these.
import { withTransaction } from './db.js'
import { conflict, forbidden, notFound } from './errors.js'
import { bpToPercentString, computeTotals, toJSONSafe } from './money.js'
import { hashSecret, newSecret, newTableId, secretMatches } from './security.js'

export const MAX_ITEMS = 100
export const MAX_PARTICIPANTS = 30

const SAMPLE_BILL = [
  ['Jollof rice', '4500'],
  ['Fried rice & chicken', '5200'],
  ['Suya platter (to share)', '9000'],
  ['Pepper soup', '3800'],
  ['Chapman', '2500'],
  ['Chapman', '2500'],
  ['Zobo jug (to share)', '3000'],
]

// ---------- reading ----------

export async function getTableView(pool, tableId, { hostKey, participantToken } = {}) {
  const t = await pool.query('SELECT * FROM bill_tables WHERE id = $1', [tableId])
  if (!t.rowCount) throw notFound()
  const table = t.rows[0]
  const [items, participants, claims] = await Promise.all([
    pool.query('SELECT id, name, price_kobo FROM items WHERE table_id = $1 ORDER BY id', [tableId]),
    pool.query('SELECT id, name, token_hash, created_at FROM participants WHERE table_id = $1 ORDER BY id', [tableId]),
    pool.query(
      `SELECT c.item_id, c.participant_id FROM claims c JOIN items i ON i.id = c.item_id
       WHERE i.table_id = $1 ORDER BY c.created_at, c.participant_id`,
      [tableId],
    ),
  ])

  const itemList = items.rows.map((r) => ({ id: String(r.id), name: r.name, priceKobo: r.price_kobo }))
  const people = participants.rows.map((r) => ({ id: String(r.id), name: r.name, joinedAt: r.created_at }))
  const claimList = claims.rows.map((r) => ({ itemId: String(r.item_id), participantId: String(r.participant_id) }))
  const totals = computeTotals({ taxBp: table.tax_bp, tipBp: table.tip_bp }, itemList, people, claimList)
  const me = participantToken ? participants.rows.find((r) => secretMatches(participantToken, r.token_hash)) : null

  return toJSONSafe({
    table: {
      id: table.id,
      name: table.name,
      taxPercent: bpToPercentString(table.tax_bp),
      tipPercent: bpToPercentString(table.tip_bp),
      finalized: table.finalized,
      createdAt: table.created_at,
    },
    items: itemList.map((it) => ({
      ...it,
      claimedBy: claimList.filter((c) => c.itemId === it.id).map((c) => c.participantId),
      shares: totals.itemShares[it.id] ?? {},
    })),
    participants: people,
    unclaimedItemIds: totals.unclaimedItemIds,
    totals: {
      participants: totals.participants,
      claimed: totals.claimed,
      unclaimed: totals.unclaimed,
      bill: totals.bill,
    },
    viewer: {
      isHost: secretMatches(hostKey, table.host_key_hash),
      participantId: me ? String(me.id) : null,
    },
  })
}

// ---------- host actions ----------

export async function createTable(pool, { name, taxBp, tipBp }) {
  const hostKey = newSecret()
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newTableId()
    try {
      await pool.query('INSERT INTO bill_tables (id, name, host_key_hash, tax_bp, tip_bp) VALUES ($1, $2, $3, $4, $5)', [
        id,
        name,
        hashSecret(hostKey),
        taxBp,
        tipBp,
      ])
      return { id, hostKey }
    } catch (err) {
      if (err.code !== '23505') throw err // retry only on share-code collision
    }
  }
  throw new Error('Could not allocate a unique table code')
}

// Locks the table row for the rest of the transaction, checks host key and (optionally) that it's still open.
async function lockAsHost(client, tableId, hostKey, { mustBeOpen = true } = {}) {
  const r = await client.query('SELECT host_key_hash, finalized FROM bill_tables WHERE id = $1 FOR UPDATE', [tableId])
  if (!r.rowCount) throw notFound()
  if (!secretMatches(hostKey, r.rows[0].host_key_hash)) throw forbidden()
  if (mustBeOpen && r.rows[0].finalized) throw conflict('finalized', 'The bill is finalized. Unlock it to make changes.')
}

async function touch(client, tableId) {
  await client.query('UPDATE bill_tables SET updated_at = now() WHERE id = $1', [tableId])
}

export function updateSettings(pool, tableId, hostKey, { name, taxBp, tipBp }) {
  return withTransaction(pool, async (client) => {
    await lockAsHost(client, tableId, hostKey)
    await client.query(
      `UPDATE bill_tables SET name = COALESCE($2, name), tax_bp = COALESCE($3, tax_bp), tip_bp = COALESCE($4, tip_bp), updated_at = now()
       WHERE id = $1`,
      [tableId, name ?? null, taxBp ?? null, tipBp ?? null],
    )
  })
}

async function assertItemRoom(client, tableId, adding) {
  const c = await client.query('SELECT count(*)::int AS n FROM items WHERE table_id = $1', [tableId])
  if (c.rows[0].n + adding > MAX_ITEMS) throw conflict('too_many_items', `A table can have at most ${MAX_ITEMS} items.`)
}

export function addItem(pool, tableId, hostKey, { name, priceKobo }) {
  return withTransaction(pool, async (client) => {
    await lockAsHost(client, tableId, hostKey)
    await assertItemRoom(client, tableId, 1)
    const r = await client.query('INSERT INTO items (table_id, name, price_kobo) VALUES ($1, $2, $3) RETURNING id', [tableId, name, priceKobo])
    await touch(client, tableId)
    return { id: String(r.rows[0].id) }
  })
}

export function loadSample(pool, tableId, hostKey) {
  return withTransaction(pool, async (client) => {
    await lockAsHost(client, tableId, hostKey)
    await assertItemRoom(client, tableId, SAMPLE_BILL.length)
    for (const [name, naira] of SAMPLE_BILL) {
      await client.query('INSERT INTO items (table_id, name, price_kobo) VALUES ($1, $2, $3)', [tableId, name, BigInt(naira) * 100n])
    }
    await touch(client, tableId)
  })
}

export function updateItem(pool, tableId, hostKey, itemId, { name, priceKobo }) {
  return withTransaction(pool, async (client) => {
    await lockAsHost(client, tableId, hostKey)
    const r = await client.query(
      'UPDATE items SET name = COALESCE($3, name), price_kobo = COALESCE($4, price_kobo) WHERE id = $1 AND table_id = $2',
      [itemId, tableId, name ?? null, priceKobo ?? null],
    )
    if (!r.rowCount) throw notFound('Item')
    await touch(client, tableId)
  })
}

export function deleteItem(pool, tableId, hostKey, itemId) {
  return withTransaction(pool, async (client) => {
    await lockAsHost(client, tableId, hostKey)
    const r = await client.query('DELETE FROM items WHERE id = $1 AND table_id = $2', [itemId, tableId])
    if (!r.rowCount) throw notFound('Item')
    await touch(client, tableId)
  })
}

export function setFinalized(pool, tableId, hostKey, finalized) {
  return withTransaction(pool, async (client) => {
    await lockAsHost(client, tableId, hostKey, { mustBeOpen: false })
    await client.query('UPDATE bill_tables SET finalized = $2, updated_at = now() WHERE id = $1', [tableId, finalized])
  })
}

// ---------- participant actions ----------

export function joinTable(pool, tableId, { name, participantToken }) {
  return withTransaction(pool, async (client) => {
    const t = await client.query('SELECT 1 FROM bill_tables WHERE id = $1 FOR SHARE', [tableId])
    if (!t.rowCount) throw notFound()

    // Same browser joining again → return the existing participant (no duplicates on refresh).
    if (participantToken) {
      const existing = await client.query('SELECT id, name FROM participants WHERE table_id = $1 AND token_hash = $2', [
        tableId,
        hashSecret(participantToken),
      ])
      if (existing.rowCount) {
        const p = existing.rows[0]
        return { participant: { id: String(p.id), name: p.name }, token: participantToken, created: false }
      }
    }

    const count = await client.query('SELECT count(*)::int AS n FROM participants WHERE table_id = $1', [tableId])
    if (count.rows[0].n >= MAX_PARTICIPANTS) throw conflict('table_full', `A table can have at most ${MAX_PARTICIPANTS} people.`)

    const token = newSecret()
    const r = await client.query(
      `INSERT INTO participants (table_id, name, name_key, token_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (table_id, name_key) DO NOTHING RETURNING id, name`,
      [tableId, name, name.toLowerCase(), hashSecret(token)],
    )
    if (!r.rowCount) throw conflict('name_taken', `Someone called “${name}” is already at this table. Try a different name.`)
    return { participant: { id: String(r.rows[0].id), name: r.rows[0].name }, token, created: true }
  })
}

// Idempotent: claimed=true inserts if missing; claimed=false deletes if present.
export function setClaim(pool, tableId, participantToken, itemId, claimed) {
  return withTransaction(pool, async (client) => {
    // FOR SHARE blocks a concurrent finalize until this claim commits (and vice versa).
    const t = await client.query('SELECT finalized FROM bill_tables WHERE id = $1 FOR SHARE', [tableId])
    if (!t.rowCount) throw notFound()
    if (t.rows[0].finalized) throw conflict('finalized', 'The bill is finalized — claims are locked.')

    const p = participantToken
      ? await client.query('SELECT id FROM participants WHERE table_id = $1 AND token_hash = $2', [tableId, hashSecret(participantToken)])
      : { rowCount: 0 }
    if (!p.rowCount) throw forbidden('Join the table before claiming items.')
    const participantId = p.rows[0].id

    const item = await client.query('SELECT 1 FROM items WHERE id = $1 AND table_id = $2', [itemId, tableId])
    if (!item.rowCount) throw notFound('Item')

    if (claimed) {
      await client.query('INSERT INTO claims (item_id, participant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [itemId, participantId])
    } else {
      await client.query('DELETE FROM claims WHERE item_id = $1 AND participant_id = $2', [itemId, participantId])
    }
    // No UPDATE of the table row here: concurrent claims only share-lock it, so they never deadlock.
  })
}
