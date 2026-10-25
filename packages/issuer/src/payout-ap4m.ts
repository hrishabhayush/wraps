// PAYOUT_RAIL=ap4m: the issuer pays merchants through a Mastercard AP4M Channel.
//
// Agents pay merchants with blind tokens; merchants settle them here. This rail turns a
// merchant's earned tab into an AP4M payment from the issuer's own registered wallet, so the
// chain shows VoucherRedeemed (issuer channel -> merchant) and nothing that links an agent to
// the merchant it paid.
//
// It uses the official toolkit unchanged: the issuer runs a one-shot x402 Merchant for the
// Channel's merchant on 127.0.0.1 and buys from it with buyResource. That Merchant redeems the
// Voucher from the issuer's wallet (gas only); AP4M pays the Channel's registered payout.
//
// The wallet must be registered as an agent for the team in the AP4M portal. Until it is, every
// batch logs that and leaves the lines unpaid.
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider, Wallet, formatUnits, parseEther, parseUnits } from 'ethers';
import { PARTICIPANT_LEDGER_INTERFACE, POOLED_ESCROW_VAULT_INTERFACE } from '@ap4m/sdk';
import { readParticipantPaymentChannel } from '@ap4m/sdk/participant-requests';
import type { X402Context } from '../vendor/ap4m/x402.mjs';
import type { PayoutLine } from './core';
import type { PayoutRail, PayoutResult } from './payout';
import { XrplEvmPayoutRail } from './payout';
import { XRPL_EVM_TESTNET_RPC } from './rail-xrpl-evm';

export const AP4M_API = 'https://hackathon.ap4m.build';
// The toolkit imports node:sqlite; load it only when this rail runs, not whenever the issuer loads.
const toolkit = () => import('../vendor/ap4m/x402.mjs');
const CHAIN_ID = 1449000n;
/** The issuer opens Channels of this size; AP4M caps hackathon Channels at 1 RLUSD. */
const CHANNEL_CAP = parseUnits('1', 18);
/** Highest gas fee the issuer pays for one AP4M transaction (channel request or redemption). */
const MAX_GAS_FEE = parseEther('0.1');

export interface Ap4mPayoutOptions {
  /** The issuer's wallet key, made in the enclave. Kept only inside the ethers Wallet. */
  privateKey: string;
  /** Team name registered with AP4M. */
  teamName: string;
  apiUrl?: string;
  rpc?: string;
  /** RLUSD token, for sweeping the wallet. */
  token?: string;
  stateDirectory?: string;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
  /** Preloaded AP4M context (tests); otherwise loaded from the service. */
  context?: X402Context;
}

interface Channel { id: string; merchantId: string; payout: string }

export class Ap4mPayoutRail implements PayoutRail {
  readonly name = 'ap4m';
  readonly canSend = true;
  readonly address: string;
  private readonly wallet: Wallet;
  private readonly provider: JsonRpcProvider;
  private readonly api: string;
  private readonly dir: string;
  private readonly fetchFn: typeof fetch;
  private readonly sweeper?: XrplEvmPayoutRail;
  private context?: X402Context;
  private channel?: Channel;
  private requestedChannel?: string;
  private busy = false;
  private sequence = 0;

  constructor(private readonly opts: Ap4mPayoutOptions) {
    this.provider = new JsonRpcProvider(opts.rpc ?? XRPL_EVM_TESTNET_RPC, Number(CHAIN_ID), { staticNetwork: true });
    this.wallet = new Wallet(opts.privateKey, this.provider);
    this.address = this.wallet.address;
    this.api = opts.apiUrl ?? AP4M_API;
    this.fetchFn = opts.fetch ?? fetch;
    this.context = opts.context;
    this.dir = opts.stateDirectory ?? join(tmpdir(), `wraps-ap4m-${this.address.toLowerCase()}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (opts.token) this.sweeper = new XrplEvmPayoutRail({ token: opts.token, payoutAddresses: {}, privateKey: opts.privateKey, rpc: opts.rpc, log: opts.log });
  }

  private log(msg: string) {
    this.opts.log?.(`[payout:ap4m] ${msg}`);
  }

  /** Empties the issuer wallet (RLUSD from top-ups, gas XRP) to `to`. AP4M Channel funds stay with AP4M. */
  sweep(to: string): Promise<string[]> {
    if (!this.sweeper) throw new Error('sweep needs the RLUSD token address');
    return this.sweeper.sweep(to);
  }

  async payout(lines: PayoutLine[]): Promise<PayoutResult[]> {
    if (this.busy || lines.length === 0) return [];
    this.busy = true;
    const results: PayoutResult[] = [];
    try {
      const channel = await this.ensureChannel();
      if (!channel) return [];
      for (const line of lines) {
        const amount = parseUnits(line.amountRlusd, 18);
        if (amount <= 0n) continue;
        const paid = await this.payOne(channel, line, amount);
        results.push({ merchantId: line.merchantId, txRef: paid, amountTokens: line.amountTokens, payTo: channel.payout, token: this.context!.x402.token, chainId: Number(CHAIN_ID) });
        this.log(`paid ${line.amountRlusd} RLUSD for ${line.merchantId} through AP4M channel ${channel.id.slice(0, 10)}… tx ${paid}`);
      }
    } catch (e) {
      // Lines not in `results` stay unpaid and are retried next batch.
      this.log(`batch stopped: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return results;
  }

  // --- AP4M service session ---------------------------------------------------

  private async session() {
    const call = async (path: string, init?: RequestInit) => {
      const r = await this.fetchFn(this.api + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      // Never echo service error bodies: they can carry authentication material.
      if (!r.ok) throw new Error(`AP4M ${path} returned HTTP ${r.status}`);
      return r.json() as Promise<any>;
    };
    const challenge = await call('/public/participant/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamName: this.opts.teamName, wallet: this.address }),
    });
    if (typeof challenge.message !== 'string' || !challenge.message || challenge.message.length > 10_000 || typeof challenge.challengeId !== 'string') {
      throw new Error('AP4M returned an invalid sign-in challenge');
    }
    const session = await call('/public/participant/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: challenge.challengeId, signature: await this.wallet.signMessage(challenge.message) }),
    });
    if (typeof session.token !== 'string' || !session.token) throw new Error('AP4M returned no session token');
    return (path: string, init?: RequestInit) => call(path, { ...init, headers: { ...init?.headers, authorization: `Bearer ${session.token}` } });
  }

  /** An open Channel from this wallet, opening one (1 RLUSD cap) if there is none. Null while unregistered. */
  private async ensureChannel(): Promise<Channel | null> {
    this.context ??= await (await toolkit()).loadX402Context(this.api);
    if (this.channel && (await this.stillOpen(this.channel.id))) return this.channel;
    let call;
    try {
      call = await this.session();
    } catch (e) {
      this.log(`waiting for AP4M registration of ${this.address} for team "${this.opts.teamName}" (${(e as Error).message})`);
      return null;
    }
    const list = async () => {
      const data = await call('/public/participant/channels');
      if (!Array.isArray(data.channels)) throw new Error('AP4M returned an invalid channel list');
      return data.channels as { channel_id: string; channel_status: string; cap_wei: string; merchant_id: string; payout: string }[];
    };
    let open = (await list()).find((c) => c.channel_status === 'open');
    if (!open) open = await this.openChannel(call, list);
    if (!open) return null;
    if (!(await this.stillOpen(open.channel_id))) throw new Error(`AP4M channel ${open.channel_id} is not open on-chain for this wallet`);
    this.channel = { id: open.channel_id, merchantId: open.merchant_id, payout: open.payout };
    this.log(`using AP4M channel ${open.channel_id} to merchant ${open.merchant_id}, payout ${open.payout}`);
    return this.channel;
  }

  private async stillOpen(channelId: string): Promise<boolean> {
    const c = await readParticipantPaymentChannel(this.provider, this.context!.participantRequest, channelId as `0x${string}`);
    return c.agent.toLowerCase() === this.address.toLowerCase() && c.status === 1 && c.redeemed < c.cap;
  }

  private async openChannel(call: (path: string, init?: RequestInit) => Promise<any>, list: () => Promise<any[]>) {
    if (!this.requestedChannel) {
      const prepared = await call('/public/participant/channel-requests/prepare', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap_rlusd: formatUnits(CHANNEL_CAP, 18) }),
      });
      // Send only a capped binding request to the configured AP4M vault, never a native transfer.
      const parsed = typeof prepared.data === 'string' ? POOLED_ESCROW_VAULT_INTERFACE.parseTransaction({ data: prepared.data }) : null;
      if (typeof prepared.to !== 'string' || prepared.to.toLowerCase() !== this.context!.participantRequest.vault.toLowerCase()
        || BigInt(String(prepared.value ?? 0)) !== 0n || parsed?.name !== 'requestPayoutBinding' || parsed.args[0].cap !== CHANNEL_CAP) {
        throw new Error('refused AP4M channel request: unexpected vault, method, cap or value');
      }
      const tx = await this.wallet.populateTransaction({ to: prepared.to, data: prepared.data, value: 0n });
      if (BigInt(tx.gasLimit ?? 0) * BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? 0) > MAX_GAS_FEE) throw new Error('AP4M channel request gas is above 0.1 XRP; nothing sent');
      const sent = await this.wallet.sendTransaction(tx);
      this.requestedChannel = sent.hash;
      this.log(`requested an AP4M channel (cap 1 RLUSD): tx ${sent.hash}`);
    }
    const receipt = await this.provider.waitForTransaction(this.requestedChannel, 1, 90_000);
    if (!receipt) return undefined; // still pending: next batch checks again
    if (receipt.status !== 1) {
      this.requestedChannel = undefined;
      throw new Error('AP4M channel request reverted');
    }
    let channel = (await list()).find((c) => c.channel_status === 'open');
    channel ??= await call('/public/participant/channel-requests', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx_hash: this.requestedChannel }),
    });
    if (!channel || typeof channel.channel_id !== 'string') throw new Error('AP4M confirmed the request but returned no channel');
    if (channel.channel_status !== 'open') {
      this.log(`AP4M channel ${channel.channel_id} is ${channel.channel_status}; checking again next batch`);
      return undefined;
    }
    this.requestedChannel = undefined;
    return channel;
  }

  // --- one payment ---------------------------------------------------------------

  /** Pays `amount` to the Channel's merchant: a one-shot local x402 Merchant, bought from with buyResource. */
  private async payOne(channel: Channel, line: PayoutLine, amount: bigint): Promise<string> {
    const context = this.context!;
    const { buyResource, createX402Merchant } = await toolkit();
    const operation = `payout-${Date.now().toString(36)}-${(this.sequence++).toString(36)}`;
    const port = await freePort();
    const resourceUrl = `http://127.0.0.1:${port}/resource`;
    const ledger = context.participantRequest.ledger.toLowerCase();
    // The local Merchant redeems from the issuer wallet. Allow only redeemVoucher on this Channel, within its cap.
    const submitter = {
      sendTransaction: async (tx: { to?: string | null; data?: string; value?: bigint }) => {
        const call = PARTICIPANT_LEDGER_INTERFACE.parseTransaction({ data: tx.data ?? '0x' });
        if ((tx.to ?? '').toLowerCase() !== ledger || (tx.value ?? 0n) !== 0n || call?.name !== 'redeemVoucher'
          || call.args[0].channelId !== channel.id || BigInt(call.args[0].cumulativeAmount) > CHANNEL_CAP) {
          throw new Error('refused an unexpected redemption');
        }
        const populated = await this.wallet.populateTransaction(tx as any);
        if (BigInt(populated.gasLimit ?? 0) * BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0) > MAX_GAS_FEE) throw new Error('redemption gas is above 0.1 XRP');
        return this.wallet.sendTransaction(populated);
      },
    };
    const merchant = createX402Merchant({
      context, provider: this.provider, submitter: submitter as any,
      stateDirectory: join(this.dir, 'merchant', operation), resourceUrl,
      merchantParticipantId: channel.merchantId, payout: channel.payout, amount: amount.toString(),
      content: { kind: 'wraps-payout', merchantId: line.merchantId, tokens: line.amountTokens, amountRlusd: line.amountRlusd },
    });
    await new Promise<void>((resolve, reject) => {
      merchant.server.once('error', reject);
      merchant.server.listen(port, '127.0.0.1', resolve);
    });
    try {
      const bought = await buyResource({
        context, provider: this.provider, wallet: this.wallet, stateDirectory: join(this.dir, 'agent'),
        resourceUrl, channelId: channel.id, maximumAmount: amount.toString(), operation,
      });
      return bought.transactionHash;
    } finally {
      await merchant.close().catch(() => {});
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no free port'))));
    });
  });
}
