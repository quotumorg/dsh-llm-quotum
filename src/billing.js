/** Read actual request spend from seat (Venice `cost`) and PAYG (`quotum_billing`) responses. Unknown is never zero. */

const FINAL = new Set(['charged', 'refunded', 'failed', 'cancelled', 'released'])

function decimalUsd(nano) {
  const sign = nano < 0n ? '-' : ''
  const abs = nano < 0n ? -nano : nano
  return `${sign}${abs / 1_000_000_000n}.${String(abs % 1_000_000_000n).padStart(9, '0')}`
}

/** Non-negative finite JSON number to integer nanodollars, or undefined. */
function nanoFromNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const nano = Math.round(value * 1e9)
  return Number.isSafeInteger(nano) ? BigInt(nano) : undefined
}

/**
 * Seat spend: Venice documents a top-level `cost: { usd, diem }` on chat completions;
 * some gateways nest it under `usage.cost`. Both portions count (diem is a dollar-equivalent credit).
 * @param {any} body the final non-stream body, or the merged stream extras
 */
export function seatSpend(body) {
  const cost = isObject(body?.cost) ? body.cost : isObject(body?.usage?.cost) ? body.usage.cost : undefined
  if (cost === undefined || !('usd' in cost || 'diem' in cost)) return { state: 'unknown' }
  const usd = 'usd' in cost ? nanoFromNumber(cost.usd) : 0n
  const diem = 'diem' in cost ? nanoFromNumber(cost.diem) : 0n
  if (usd === undefined || diem === undefined) return { state: 'unknown' }
  return { state: 'known', nano: usd + diem, usd: decimalUsd(usd + diem), parts: { usd: decimalUsd(usd), diem: decimalUsd(diem) } }
}

/**
 * PAYG spend from `quotum_billing`: the final customer charge in integer USD nanodollars.
 * Pending or malformed billing stays pending/unknown so callers check the receipt before retrying.
 * @param {any} bill
 */
export function paygSpend(bill) {
  if (!isObject(bill)) return { state: 'unknown' }
  const receipt = typeof bill.id === 'string' && bill.id.length > 0 ? bill.id : undefined
  if (bill.unit !== undefined && bill.unit !== 'USD-nano') return { state: 'unknown', receipt }
  let final = isObject(bill.footer) ? bill.footer.finalPrice : undefined
  const status = typeof bill.status === 'string' ? bill.status : undefined
  if (final === undefined && (status === undefined || FINAL.has(status))) final = bill.charge
  if (status !== undefined && !FINAL.has(status) && (final === undefined || final === null)) return { state: 'pending', receipt, status }
  if (!Number.isSafeInteger(final) || final < 0) return { state: status === 'pending' ? 'pending' : 'unknown', receipt, status }
  const nano = BigInt(final)
  return { state: 'known', nano, usd: decimalUsd(nano), receipt, status }
}

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

