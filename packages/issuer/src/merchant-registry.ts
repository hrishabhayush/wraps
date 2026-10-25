// Merchant registry: merchant ID → RLUSD payout address on XRPL EVM. Set by config at start-up.
// A merchant is paid on-chain only at its registered address. An address cannot be changed once
// registered: a request to change it is refused, so a compromised config path cannot redirect funds.

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MERCHANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class MerchantRegistry {
  private readonly map = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [id, address] of Object.entries(entries)) this.register(id, address);
  }

  /** Adds a merchant. Registering the same address again is a no-op; a different address is refused. */
  register(merchantId: string, address: string): void {
    if (!MERCHANT_ID.test(merchantId)) throw new Error(`bad merchant id: ${JSON.stringify(merchantId)}`);
    if (!EVM_ADDRESS.test(address)) throw new Error(`bad payout address for ${merchantId}: ${address}`);
    if (/^0x0{40}$/.test(address)) throw new Error(`refusing the zero address as payout address for ${merchantId}`);
    const existing = this.map.get(merchantId);
    if (existing && existing !== address.toLowerCase()) {
      throw new Error(`payout address for ${merchantId} is already registered; changing it is refused`);
    }
    this.map.set(merchantId, address.toLowerCase());
  }

  /** Registered address (lower case), or undefined. */
  get(merchantId: string): string | undefined {
    return this.map.get(merchantId);
  }

  has(merchantId: string): boolean {
    return this.map.has(merchantId);
  }

  get size(): number {
    return this.map.size;
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.map);
  }

  /**
   * Parses `MERCHANT_PAYOUT_ADDRESSES`: either a JSON object `{"m-1":"0x…"}` or a comma list
   * `m-1=0x…,m-2=0x…`. A merchant listed twice with different addresses is refused.
   */
  static parse(spec: string | undefined): MerchantRegistry {
    const r = new MerchantRegistry();
    const s = (spec ?? '').trim();
    if (!s) return r;
    if (s.startsWith('{')) {
      const obj = JSON.parse(s) as Record<string, unknown>;
      for (const [id, a] of Object.entries(obj)) r.register(id, String(a));
      return r;
    }
    for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
      const eq = part.indexOf('=');
      if (eq < 1) throw new Error(`bad MERCHANT_PAYOUT_ADDRESSES entry: ${part} (want id=0xaddress)`);
      r.register(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return r;
  }
}
