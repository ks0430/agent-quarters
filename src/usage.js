// Internal AWS cost accounting for Lightsail instances.
// Lightsail bills hourly, capped at the bundle's monthly price per calendar
// month. We mirror that: per-month overlap hours x (monthly/730), capped.
// Estimates only — excludes data-transfer overages and detached static IPs.

export const BUNDLE_PRICES = {
  nano_3_0: 5,
  micro_3_0: 7,
  small_3_0: 12,
  medium_3_0: 24,
  large_3_0: 44,
  xlarge_3_0: 84,
};

export const monthlyPrice = (bundle) => BUNDLE_PRICES[bundle] ?? 12;

// sqlite datetime('now') strings are UTC "YYYY-MM-DD HH:MM:SS"
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

// Hours of [start, end] falling inside the UTC month containing `anchor`.
function monthOverlapHours(start, end, anchor) {
  const mStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const mEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  const s = Math.max(start.getTime(), mStart.getTime());
  const e = Math.min(end.getTime(), mEnd.getTime());
  return Math.max(0, (e - s) / 3600000);
}

export function instanceUsage(inst, now = new Date()) {
  const start = parseUtc(inst.created_at);
  const end = inst.deleted_at ? parseUtc(inst.deleted_at) : now;
  const monthly = monthlyPrice(inst.bundle);
  const hourly = monthly / 730;

  let costTotal = 0;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor < end) {
    const h = monthOverlapHours(start, end, cursor);
    costTotal += Math.min(h * hourly, monthly);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const hoursTotal = Math.max(0, (end - start) / 3600000);
  const hoursThisMonth = monthOverlapHours(start, end, now);
  const costThisMonth = Math.min(hoursThisMonth * hourly, monthly);

  return {
    hoursTotal: +hoursTotal.toFixed(1),
    costTotal: +costTotal.toFixed(2),
    costThisMonth: +costThisMonth.toFixed(2),
    monthlyRate: inst.deleted_at ? 0 : monthly,
    running: !inst.deleted_at,
  };
}
