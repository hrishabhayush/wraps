// Seam between the UI and the VPN network (nodes, attestation, tunnel). TauriBackend is the
// real one-click VPN (attested relay + WireGuard, see src-tauri/src/vpn.rs); MockBackend is
// for the browser dev preview. Wallet top-ups live in tokens.ts.
import type { Quote } from './tokens.ts';


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
  | { ok: true; tee: 'tdx' | 'sev' | 'sev-snp'; build: string; checkedAt: number }
  | { ok: false; reason: string; checkedAt: number };

export type Activity = { title: string; detail: string; usd: number; at: number; tx?: string };

export interface Backend {
  listNodes(): Promise<VpnNode[]>;
  attest(nodeId: string): Promise<Attestation>;
  disconnect(): Promise<void>;
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

export class MockBackend implements Backend {
  async listNodes() { return NODES; }
  async attest(nodeId: string): Promise<Attestation> {
    await sleep(1400);
    return TAMPERED.has(nodeId)
      ? { ok: false, reason: 'Enclave build doesn’t match the audited code', checkedAt: Date.now() }
      : { ok: true, tee: 'tdx', build: 'a41f…9c', checkedAt: Date.now() };
  }
  async connect(_nodeId: string) { await sleep(500); }
  async disconnect() {}
}

// The live wraps relay: Google Confidential Space (AMD SEV), reserved IP.
const LIVE_RELAY: VpnNode = {
  id: 'usc1', city: 'Iowa', country: 'United States',
  flag: { h: ['#B22234', '#FFFFFF', '#3C3B6E'] },
  ip: '136.80.57.82', pricePerMB: 0.01, latencyMs: 30, // 1 token = 10 MB = $0.10
};

/** Real backend: verify the attested relay, pay it, bring WireGuard up. No other app needed. */
export class TauriBackend implements Backend {
  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  async listNodes() { return [LIVE_RELAY]; }
  async attest(_nodeId: string): Promise<Attestation> {
    try {
      const r = await this.call<{ ok: boolean; imageDigest: string }>('vpn_attest');
      return { ok: true, tee: 'sev', build: `${r.imageDigest.slice(7, 11)}…${r.imageDigest.slice(-2)}`, checkedAt: Date.now() };
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 120), checkedAt: Date.now() };
    }
  }
  /** Pays the relay with these kept tokens (10 MB each), registers a fresh key, turns the tunnel on. */
  async connectWith(tokens: string[]) { return this.call<{ tokens: number; megabytes: number }>('vpn_connect', { tokens }); }
  /** Mock rail top-up from the live issuer. Returns the tokens for the wallet to keep. */
  async topUpMock(n: number) { return (await this.call<{ tokens: string[] }>('topup_mock', { tokens: n })).tokens; }
  /** RLUSD top-up, step 1: the attested issuer's quote for `n` tokens. */
  async topUpQuote(n: number) { return this.call<Quote>('topup_quote', { tokens: n }); }
  /** RLUSD top-up, step 2: the quote is paid in `txHash`. Returns the tokens for the wallet to keep. */
  async topUpPaid(txHash: string) { return (await this.call<{ tokens: string[] }>('topup_paid', { txHash })).tokens; }
  async topUpCancel() { await this.call('topup_cancel'); }
  async openTx(txHash: string) { await this.call('open_tx', { txHash }); }
  async disconnect() { await this.call('vpn_disconnect'); }
}
