// A small fake XRPL EVM node at the JSON-RPC transport level, for payout tests without a chain.
// It parses and recovers real signed transactions (viem), tracks nonces, a mempool and one
// ERC-20 token, and can drop answers or refuse sends to simulate a flaky RPC.
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';

export type SendBehavior = 'ok' | 'timeout-after-accept' | 'timeout-before-accept' | 'reject';

interface Tx {
  hash: Hex;
  raw: Hex;
  from: string;
  to: string;
  nonce: number;
  data: string;
  value: bigint;
  chainId?: number;
  gas: bigint;
  gasPrice: bigint;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (h: string) => '0x' + h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export class FakeEvm {
  chainId = 1449000;
  gasPrice = 10n ** 9n;
  estimate = 50_000n;
  automine = true;
  readonly balances = new Map<string, bigint>();
  readonly txs = new Map<string, Tx>();
  readonly receipts = new Map<string, { status: string; transactionHash: string; logs: unknown[] }>();
  private readonly mined = new Map<string, number>();
  private mempool: Tx[] = [];
  /** Every eth_sendRawTransaction body, in order (rebroadcasts included). */
  readonly sends: Hex[] = [];
  readonly calls: string[] = [];
  /** Behaviour of each next send, consumed in order; then 'ok'. */
  sendPlan: SendBehavior[] = [];

  constructor(readonly token: string) {}

  fund(addr: string, amount: bigint) {
    this.balances.set(addr.toLowerCase(), this.bal(addr) + amount);
  }

  bal(addr: string): bigint {
    return this.balances.get(addr.toLowerCase()) ?? 0n;
  }

  /** Marks a nonce as used by some other tx (e.g. sent from another wallet with the same key). */
  burnNonce(addr: string) {
    this.mined.set(addr.toLowerCase(), (this.mined.get(addr.toLowerCase()) ?? 0) + 1);
  }

  private nonceOf(addr: string, tag: string): number {
    const a = addr.toLowerCase();
    const latest = this.mined.get(a) ?? 0;
    return tag === 'pending' ? latest + this.mempool.filter((t) => t.from === a).length : latest;
  }

  private decode(data: string): { to: string; amount: bigint } | null {
    const d = data.replace(/^0x/, '').toLowerCase();
    if (!d.startsWith('a9059cbb') || d.length !== 136) return null;
    return { to: '0x' + d.slice(32, 72), amount: BigInt('0x' + d.slice(72)) };
  }

  /** Mines the mempool in nonce order. */
  mine() {
    const pool = this.mempool.sort((a, b) => a.nonce - b.nonce);
    this.mempool = [];
    for (const t of pool) {
      if (t.nonce !== (this.mined.get(t.from) ?? 0)) {
        this.mempool.push(t); // gap: waits
        continue;
      }
      this.mined.set(t.from, t.nonce + 1);
      const x = this.decode(t.data);
      let status = '0x0';
      const logs: unknown[] = [];
      if (t.to === this.token.toLowerCase() && x && t.value === 0n && this.bal(t.from) >= x.amount) {
        this.balances.set(t.from, this.bal(t.from) - x.amount);
        this.fund(x.to, x.amount);
        status = '0x1';
        logs.push({ address: this.token, topics: [TRANSFER_TOPIC, pad(t.from), pad(x.to)], data: pad(x.amount.toString(16)) });
      }
      this.receipts.set(t.hash, { status, transactionHash: t.hash, logs });
    }
  }

  private async accept(raw: Hex): Promise<Hex> {
    const hash = keccak256(raw);
    if (this.txs.has(hash)) {
      if (this.receipts.has(hash)) throw new RpcFail('nonce too low');
      throw new RpcFail('already known');
    }
    const p = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    const nonce = Number(p.nonce ?? 0);
    if (nonce < this.nonceOf(from, 'latest')) throw new RpcFail('nonce too low');
    const tx: Tx = {
      hash, raw, from, nonce,
      to: (p.to ?? '').toLowerCase(), data: p.data ?? '0x', value: p.value ?? 0n,
      chainId: p.chainId, gas: p.gas ?? 0n, gasPrice: (p as { gasPrice?: bigint }).gasPrice ?? 0n,
    };
    if (tx.chainId !== this.chainId) throw new RpcFail('invalid chain id');
    this.txs.set(hash, tx);
    this.mempool.push(tx);
    if (this.automine) this.mine();
    return hash;
  }

  private async handle(method: string, params: any[]): Promise<unknown> {
    switch (method) {
      case 'eth_chainId': return '0x' + this.chainId.toString(16);
      case 'eth_gasPrice': return '0x' + this.gasPrice.toString(16);
      case 'eth_call': return '0x' + '12'.padStart(64, '0');
      case 'eth_getTransactionCount': return '0x' + this.nonceOf(params[0], params[1]).toString(16);
      case 'eth_estimateGas': {
        const x = this.decode(params[0].data);
        if (!x || this.bal(params[0].from) < x.amount) throw new RpcFail('execution reverted: balance');
        return '0x' + this.estimate.toString(16);
      }
      case 'eth_getTransactionReceipt': return this.receipts.get(params[0]) ?? null;
      case 'eth_sendRawTransaction': {
        this.sends.push(params[0]);
        const b = this.sendPlan.shift() ?? 'ok';
        if (b === 'reject') throw new RpcFail('insufficient funds for gas');
        if (b === 'timeout-before-accept') throw new TimeoutFail();
        const h = await this.accept(params[0]);
        if (b === 'timeout-after-accept') throw new TimeoutFail();
        return h;
      }
      default: throw new RpcFail(`method ${method} not supported`);
    }
  }

  readonly fetch = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    this.calls.push(method);
    try {
      const result = await this.handle(method, params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    } catch (e) {
      if (e instanceof TimeoutFail) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: (e as Error).message } }));
    }
  }) as typeof fetch;

  /** Transfers mined with success, as [to, amount] pairs. */
  paid(): { to: string; amount: bigint; hash: string }[] {
    const out: { to: string; amount: bigint; hash: string }[] = [];
    for (const [hash, r] of this.receipts) {
      if (r.status !== '0x1') continue;
      const x = this.decode(this.txs.get(hash)!.data)!;
      out.push({ ...x, hash });
    }
    return out;
  }
}

class RpcFail extends Error {}
class TimeoutFail extends Error {}
