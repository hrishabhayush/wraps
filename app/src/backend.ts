// The one seam between the UI and the network. Everything here is mocked for v1:
// swap MockBackend for a real implementation (attestation, tunnel, payments) later.

export type Flag = { bg?: string; h?: string[]; nordic?: [string, string?]; cross?: string; dot?: string };

export type VpnNode = {
  id: string;
  city: string;
  country: string;
  flag: Flag;
  ip: string;
  pricePerMB: number; // USD
  latencyMs: number;
};

export type Attestation =
  | { ok: true; tee: 'tdx' | 'sev-snp'; build: string; checkedAt: number }
  | { ok: false; reason: string; checkedAt: number };

export type Activity = { title: string; detail: string; usd: number; at: number };
export type Wallet = { usd: number; history: Activity[] };

export interface Backend {
  listNodes(): Promise<VpnNode[]>;
  attest(nodeId: string): Promise<Attestation>;
  connect(nodeId: string): Promise<void>;
  disconnect(): Promise<void>;
  wallet(): Promise<Wallet>;
  topUp(usd: number): Promise<Wallet>;
  charge(usd: number): Wallet; // sync: called every second by the meter
  record(a: Activity): Promise<Wallet>;
}

const NODES: VpnNode[] = [
  { id: 'zrh', city: 'Zürich', country: 'Switzerland', flag: { bg: '#D52B1E', cross: '#FFFFFF' }, ip: '185.12.44.9', pricePerMB: 0.002, latencyMs: 18 },
  { id: 'rkv', city: 'Reykjavík', country: 'Iceland', flag: { bg: '#02529C', nordic: ['#FFFFFF', '#DC1E35'] }, ip: '89.17.140.22', pricePerMB: 0.003, latencyMs: 41 },
  { id: 'sto', city: 'Stockholm', country: 'Sweden', flag: { bg: '#006AA7', nordic: ['#FECC00'] }, ip: '46.246.3.120', pricePerMB: 0.002, latencyMs: 24 },
  { id: 'fra', city: 'Frankfurt', country: 'Germany', flag: { h: ['#000000', '#DD0000', '#FFCE00'] }, ip: '194.36.25.71', pricePerMB: 0.001, latencyMs: 12 },
  { id: 'ams', city: 'Amsterdam', country: 'Netherlands', flag: { h: ['#AE1C28', '#FFFFFF', '#21468B'] }, ip: '45.83.220.14', pricePerMB: 0.001, latencyMs: 15 },
  { id: 'tyo', city: 'Tokyo', country: 'Japan', flag: { bg: '#FFFFFF', dot: '#BC002D' }, ip: '103.152.20.9', pricePerMB: 0.004, latencyMs: 182 },
];

// Mock: Tokyo's enclave reports a build that doesn't match the audited one, to show refusal.
const TAMPERED = new Set(['tyo']);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const KEY = 'wraps.wallet';

export class MockBackend implements Backend {
  private w: Wallet = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {
    usd: 12.4,
    history: [{ title: 'Top up · RLUSD', detail: '500 tokens minted', usd: 5, at: Date.now() - 86400e3 }],
  };
  private save() { localStorage.setItem(KEY, JSON.stringify(this.w)); return this.w; }

  async listNodes() { return NODES; }
  async attest(nodeId: string): Promise<Attestation> {
    await sleep(1400);
    return TAMPERED.has(nodeId)
      ? { ok: false, reason: 'Enclave build doesn’t match the audited code', checkedAt: Date.now() }
      : { ok: true, tee: 'tdx', build: 'a41f…9c', checkedAt: Date.now() };
  }
  async connect(_nodeId: string) { await sleep(500); }
  async disconnect() {}
  async wallet() { return this.w; }
  async topUp(usd: number) {
    await sleep(900);
    this.w.usd += usd;
    this.w.history.unshift({ title: 'Top up · RLUSD', detail: `${Math.round(usd * 100).toLocaleString()} tokens minted`, usd, at: Date.now() });
    return this.save();
  }
  charge(usd: number) { this.w.usd = Math.max(0, this.w.usd - usd); return this.save(); }
  async record(a: Activity) { this.w.history.unshift(a); this.w.history.length = Math.min(this.w.history.length, 20); return this.save(); }
}
