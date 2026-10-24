// Display only. All amounts arrive from the server as integer kobo; we never do money math here.
export function formatNaira(kobo) {
  const k = Math.round(Number(kobo) || 0)
  const naira = Math.floor(k / 100)
  const rest = String(k % 100).padStart(2, '0')
  return `₦${naira.toLocaleString('en-US')}.${rest}`
}
