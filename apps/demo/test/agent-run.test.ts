import { describe, expect, it } from 'vitest';
import { runPrivateAgent } from '../src/agent-run';

describe('private agent pane', () => {
  it('runs end to end against the current issuer and merchant (quotes, key epochs)', async () => {
    const events: { type: string; data: unknown }[] = [];
    await runPrivateAgent((type, data) => events.push({ type, data }));
    const types = events.map((e) => e.type);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toEqual([]);
    expect(types).toContain('sdk:attested');
    expect(types).toContain('sdk:topup-done');
    expect(types).toContain('sdk:paid');
    expect(types.at(-1)).toBe('complete');
    // The merchant serves only a paid request that names its single-use quote and settles at the issuer.
    const settled = events.filter((e) => e.type === 'merchant' && /paid \d+ tokens.*claim #\d+ verified/.test((e.data as { message: string }).message));
    expect(settled.length).toBe(events.filter((e) => e.type === 'sdk:paid').length);
  });
});
