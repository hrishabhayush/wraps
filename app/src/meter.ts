// Pay-only-while-connected billing. Pure so it can be tested without the UI.

export const USD_PER_TOKEN = 0.01;

export type Meter = { mb: number; cost: number };

// Advance a session by dt seconds of traffic at mbPerSec, charging pricePerMB.
// Never charges more than the remaining balance; `exhausted` tells the caller to disconnect.
export function tick(m: Meter, dt: number, mbPerSec: number, pricePerMB: number, balance: number) {
  const want = mbPerSec * dt * pricePerMB;
  const charge = Math.min(want, Math.max(balance, 0));
  const mb = m.mb + (want > 0 ? (charge / want) * mbPerSec * dt : 0);
  return { meter: { mb, cost: m.cost + charge }, charge, exhausted: charge < want };
}

export const tokensFor = (usd: number) => Math.round(usd / USD_PER_TOKEN);

export function clock(seconds: number) {
  const s = Math.floor(seconds);
  return [s / 3600, (s % 3600) / 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');
}
