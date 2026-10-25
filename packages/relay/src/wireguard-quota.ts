import { createHash } from 'node:crypto';

export const WIREGUARD_BYTES_PER_TOKEN = 10_000_000;
const TABLE = 'wraps_wg';

export interface WireGuardQuotaController {
  enable(publicKey: string, address: string): Promise<void>;
  usedBytes(): Promise<Map<string, number>>;
  reset(publicKey: string): Promise<void>;
  close(): Promise<void>;
}

/** nftables named quotas count both directions against one shared peer quota. */
export async function createWireGuardQuotaController(
  run: (command: string, args: string[], input?: string) => Promise<string>,
): Promise<WireGuardQuotaController> {
  await run('nft', ['add', 'table', 'inet', TABLE]);
  try {
    await run('nft', ['add', 'chain', 'inet', TABLE, 'forward', '{', 'type', 'filter', 'hook', 'forward', 'priority', '-10', ';', 'policy', 'accept', ';', '}']);
    await run('nft', ['add', 'chain', 'inet', TABLE, 'peers']);
    await run('nft', ['add', 'rule', 'inet', TABLE, 'forward', 'iifname', 'wg0', 'jump', 'peers']);
    await run('nft', ['add', 'rule', 'inet', TABLE, 'forward', 'oifname', 'wg0', 'jump', 'peers']);
    await run('nft', ['add', 'rule', 'inet', TABLE, 'peers', 'iifname', 'wg0', 'drop']);
    await run('nft', ['add', 'rule', 'inet', TABLE, 'peers', 'oifname', 'wg0', 'drop']);
  } catch (error) {
    try { await run('nft', ['delete', 'table', 'inet', TABLE]); } catch { /* best-effort rollback */ }
    throw error;
  }

  const names = new Map<string, string>();
  return {
    async enable(publicKey, address) {
      if (names.has(publicKey)) throw new Error('WireGuard peer quota already exists');
      const name = `p_${createHash('sha256').update(publicKey).digest('hex').slice(0, 24)}`;
      await run('nft', ['-f', '-'], [
        `add quota inet ${TABLE} ${name} { until ${WIREGUARD_BYTES_PER_TOKEN} bytes; }`,
        `insert rule inet ${TABLE} peers iifname "wg0" ip saddr ${address} quota name "${name}" accept`,
        `insert rule inet ${TABLE} peers oifname "wg0" ip daddr ${address} quota name "${name}" accept`,
      ].join('\n'));
      names.set(publicKey, name);
    },
    async usedBytes() {
      const listing = await run('nft', ['list', 'quotas', 'inet', TABLE]);
      const result = new Map<string, number>();
      for (const [publicKey, name] of names) {
        const match = new RegExp(`quota\\s+${name}\\s+\\{[^}]*?used\\s+(\\d+)\\s+bytes`, 's').exec(listing);
        if (!match) throw new Error('WireGuard quota counter is unavailable');
        result.set(publicKey, Number(match[1]));
      }
      return result;
    },
    async reset(publicKey) {
      const name = names.get(publicKey);
      if (!name) throw new Error('WireGuard peer quota does not exist');
      await run('nft', ['reset', 'quota', 'inet', TABLE, name]);
    },
    async close() {
      try { await run('nft', ['delete', 'table', 'inet', TABLE]); } finally { names.clear(); }
    },
  };
}
