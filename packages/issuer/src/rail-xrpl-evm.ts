// Top-up rail for a user paying from their own wallet: a plain RLUSD (ERC-20) transfer on the
// XRPL EVM sidechain to the issuer's payout address. The issuer checks the chain itself.
//
// Binding a payment to a quote: tx hashes are public, so anyone could submit someone else's
// payment with their own quote. The payer appends the 16-byte quoteId after the transfer
// calldata (ERC-20 contracts ignore trailing bytes). The issuer accepts a tx only for that quote.
//
// Payment header (base64url JSON): { quoteId, txHash }
import { EventEmitter } from 'node:events';
import { PaymentRequirement } from './protocol';
import { RedeemResult, TopUpRail } from './rail';

export const XRPL_EVM_SCHEME = 'xrpl-evm-erc20-transfer';
export const XRPL_EVM_TESTNET_RPC = 'https://rpc.testnet.xrplevm.org';

const TRANSFER_SELECTOR = 'a9059cbb';
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DECIMALS_SELECTOR = '0x313ce567';

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** Exact decimal string → base units. */
export function toUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export interface XrplEvmPayment {
  quoteId: string;
  txHash: string;
}

export interface XrplEvmRailOptions {
  /** RLUSD ERC-20 contract on the sidechain. */
  token: string;
  rpc?: string;
  network?: string;
  fetch?: typeof fetch;
}

interface RpcTx { to: string | null; input: string }
interface RpcReceipt { status: string; logs: { address: string; topics: string[]; data: string }[] }

export class XrplEvmTransferRail extends EventEmitter implements TopUpRail {
  readonly scheme = XRPL_EVM_SCHEME;
  readonly network: string;
  readonly payTo: string;
  private readonly token: string;
  private readonly rpcUrl: string;
  private readonly fetch: typeof fetch;
  private decimals?: number;
  /** Tx hashes already turned into tokens (or being checked right now). */
  private readonly used = new Set<string>();

  constructor(payTo: string, opts: XrplEvmRailOptions) {
    super();
    for (const a of [payTo, opts.token]) if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`bad address: ${a}`);
    this.payTo = payTo;
    this.token = opts.token.toLowerCase();
    this.rpcUrl = opts.rpc ?? XRPL_EVM_TESTNET_RPC;
    this.network = opts.network ?? 'xrpl-evm-testnet';
    this.fetch = opts.fetch ?? fetch;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const r = await this.fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
    return j.result as T;
  }

  private async tokenDecimals(): Promise<number> {
    this.decimals ??= Number(BigInt(await this.rpc<string>('eth_call', [{ to: this.token, data: DECIMALS_SELECTOR }, 'latest'])));
    return this.decimals;
  }

  async redeem(paymentHeader: string, req: PaymentRequirement): Promise<RedeemResult> {
    let p: XrplEvmPayment;
    try {
      p = JSON.parse(Buffer.from(paymentHeader, 'base64url').toString('utf8'));
    } catch {
      throw new Error('payment is not valid JSON');
    }
    if (p.quoteId !== req.quoteId) throw new Error('payment is for a different quote');
    if (!/^0x[0-9a-fA-F]{64}$/.test(p.txHash ?? '')) throw new Error('bad tx hash');
    const hash = p.txHash.toLowerCase();
    if (this.used.has(hash)) throw new Error('payment already used');
    this.used.add(hash); // claim before awaiting, so two requests can't both pass
    try {
      await this.check(hash, req);
    } catch (e) {
      this.used.delete(hash);
      throw e;
    }
    this.emit('PaymentVerified', { txHash: hash, payee: this.payTo, amountRlusd: req.amountRlusd, quoteId: req.quoteId, at: Date.now() });
    return { amountTokens: req.tokens, txRef: hash };
  }

  private async check(hash: string, req: PaymentRequirement) {
    const [tx, rc] = await Promise.all([
      this.rpc<RpcTx | null>('eth_getTransactionByHash', [hash]),
      this.rpc<RpcReceipt | null>('eth_getTransactionReceipt', [hash]),
    ]);
    if (!tx || !rc) throw new Error('transaction not found or not confirmed yet');
    if (rc.status !== '0x1') throw new Error('transaction reverted');
    if (tx.to?.toLowerCase() !== this.token) throw new Error('not an RLUSD transfer');

    const input = tx.input.toLowerCase().replace(/^0x/, '');
    if (!input.startsWith(TRANSFER_SELECTOR + word(this.payTo))) throw new Error('transfer is not to the issuer payout address');
    if (input.length !== 8 + 128 + 32 || !input.endsWith(req.quoteId.toLowerCase())) throw new Error('transfer was not made for this quote');

    const need = toUnits(req.amountRlusd, await this.tokenDecimals());
    if (BigInt('0x' + input.slice(72, 136)) < need) throw new Error('transfer is below the quoted price');

    // The calldata says what was asked for; the Transfer event proves it happened.
    const moved = rc.logs.find(
      (l) => l.address.toLowerCase() === this.token && l.topics[0] === TRANSFER_TOPIC && word(l.topics[2] ?? '') === word(this.payTo),
    );
    if (!moved || BigInt(moved.data) < need) throw new Error('no matching RLUSD Transfer event');
  }
}

/** Client side: calldata for paying a quote (transfer + trailing quoteId). */
export function quotePaymentCalldata(req: Pick<PaymentRequirement, 'payTo' | 'quoteId'>, amount: bigint): string {
  if (!/^[0-9a-fA-F]{32}$/.test(req.quoteId)) throw new Error('quoteId must be 16 bytes hex');
  return '0x' + TRANSFER_SELECTOR + word(req.payTo) + word(amount.toString(16)) + req.quoteId.toLowerCase();
}
