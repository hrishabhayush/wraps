// ISS-06 payouts against a local EVM: anvil (Foundry) with chain ID 1449000 and a deployed
// minimal ERC-20. Skipped when anvil is not installed. Install: https://getfoundry.sh
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MockAttestationProvider, b64u, fromB64u } from '@wraps/attestation';
import { blindTokens, finalizeTokens, serializeToken } from '@wraps/tokens';
import { IssuerCore, MockTopUpRail, MockTopUpWallet, PayoutScheduler, XrplEvmPayoutRail, toUnits, verifyPayoutRecord } from '../src/index';

const hasAnvil = spawnSync('anvil', ['--version']).status === 0;

// Anvil's well-known dev keys (public test keys, hold nothing anywhere real).
const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FUNDER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const issuer = privateKeyToAccount(ISSUER_KEY);
const funder = privateKeyToAccount(FUNDER_KEY);

// solc 0.8.28, optimizer 200 runs, evm paris. Source:
//   contract TestRlusd {
//     mapping(address => uint256) public balanceOf;
//     uint8 public constant decimals = 18;
//     event Transfer(address indexed from, address indexed to, uint256 value);
//     constructor(uint256 supply) { balanceOf[msg.sender] = supply; emit Transfer(address(0), msg.sender, supply); }
//     function transfer(address to, uint256 value) external returns (bool) {
//       require(balanceOf[msg.sender] >= value, "balance");
//       balanceOf[msg.sender] -= value; balanceOf[to] += value;
//       emit Transfer(msg.sender, to, value); return true;
//     }
//   }
const TEST_RLUSD_BYTECODE =
  '0x6080604052348015600f57600080fd5b50604051610312380380610312833981016040819052602c916073565b33600081815260208181526040808320859055518481527fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef910160405180910390a350608b565b600060208284031215608457600080fd5b5051919050565b6102788061009a6000396000f3fe608060405234801561001057600080fd5b50600436106100415760003560e01c8063313ce5671461004657806370a0823114610065578063a9059cbb14610093575b600080fd5b61004e601281565b60405160ff90911681526020015b60405180910390f35b6100856100733660046101ba565b60006020819052908152604090205481565b60405190815260200161005c565b6100a66100a13660046101dc565b6100b6565b604051901515815260200161005c565b336000908152602081905260408120548211156101035760405162461bcd60e51b815260206004820152600760248201526662616c616e636560c81b604482015260640160405180910390fd5b336000908152602081905260408120805484929061012290849061021c565b90915550506001600160a01b0383166000908152602081905260408120805484929061014f90849061022f565b90915550506040518281526001600160a01b0384169033907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9060200160405180910390a35060015b92915050565b80356001600160a01b03811681146101b557600080fd5b919050565b6000602082840312156101cc57600080fd5b6101d58261019e565b9392505050565b600080604083850312156101ef57600080fd5b6101f88361019e565b946020939093013593505050565b634e487b7160e01b600052601160045260246000fd5b8181038181111561019857610198610206565b808201808211156101985761019861020656fea2646970667358221220f365617f812a5098c2d85f56fd44ef7a71483cc45ff50230505d2fd93de3278e64736f6c634300081c0033';

const word = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const RLUSD = (s: string) => toUnits(s, 18);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomAddress = () => ('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex')) as Hex;

let node: ChildProcess | undefined;
let RPC = '';

async function rpc<T = string>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

async function sendFrom(key: typeof funder, tx: { to?: Hex; data: Hex }) {
  const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [key.address, 'pending'])));
  const raw = await key.signTransaction({ type: 'legacy', chainId: 1449000, nonce, gas: 1_000_000n, gasPrice: BigInt(await rpc('eth_gasPrice')), value: 0n, ...tx });
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  for (let i = 0; i < 100; i++) {
    const rc = await rpc<{ status: string; contractAddress: string } | null>('eth_getTransactionReceipt', [hash]);
    if (rc) return rc;
    await sleep(20);
  }
  throw new Error('no receipt');
}

async function deployToken(): Promise<Hex> {
  const rc = await sendFrom(funder, { data: (TEST_RLUSD_BYTECODE + word(RLUSD('1000000').toString(16))) as Hex });
  return rc.contractAddress as Hex;
}

const transferData = (to: string, amount: bigint) => ('0xa9059cbb' + word(to) + word(amount.toString(16))) as Hex;
const fundIssuer = (token: Hex, rlusd: string) => sendFrom(funder, { to: token, data: transferData(issuer.address, RLUSD(rlusd)) });
const balanceOf = async (token: Hex, who: string) => BigInt(await rpc('eth_call', [{ to: token, data: '0x70a08231' + word(who) }, 'latest']));

const wallet = new MockTopUpWallet();
async function coreWithTabs(tabs: Record<string, number>) {
  const core = await IssuerCore.create({ provider: new MockAttestationProvider({ buildName: 'issuer' }), rail: new MockTopUpRail() });
  for (const [m, n] of Object.entries(tabs)) {
    const pending = await blindTokens(core.publicKeys.token, n, core.name);
    const responses = await core.issuePaid(pending.map((p) => b64u(p.request)), await wallet.pay(core.quote(n)));
    await core.settle(m, (await finalizeTokens(pending, responses.map(fromB64u))).map(serializeToken));
  }
  return core;
}

function rail(token: Hex, payoutAddresses: Record<string, string>, f?: typeof fetch, receiptTimeoutMs = 2_000) {
  return new XrplEvmPayoutRail({ token, payoutAddresses, privateKey: ISSUER_KEY, rpc: RPC, fetch: f, receiptTimeoutMs, pollMs: 20 });
}

describe.skipIf(!hasAnvil)('XrplEvmPayoutRail on a local EVM (anvil, chain 1449000)', () => {
  beforeAll(async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    RPC = `http://127.0.0.1:${port}`;
    node = spawn('anvil', ['--port', String(port), '--chain-id', '1449000', '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 200; i++) {
      try {
        await rpc('eth_chainId');
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error('anvil did not start');
  });
  afterAll(() => {
    node?.kill();
  });

  it('pays each merchant its tab in RLUSD, marks tabs paid only with a receipt, and records the tx hash', async () => {
    const token = await deployToken();
    await fundIssuer(token, '10');
    const [a, b] = [randomAddress(), randomAddress()];
    const core = await coreWithTabs({ 'm-a': 1, 'm-b': 2 });
    const paid = await new PayoutScheduler(core, rail(token, { 'm-a': a, 'm-b': b }), 1e9).runOnce();
    expect(paid.map((p) => [p.merchantId, p.amountTokens])).toEqual([['m-a', 1], ['m-b', 2]]);
    expect(await balanceOf(token, a)).toBe(RLUSD('0.1'));
    expect(await balanceOf(token, b)).toBe(RLUSD('0.2'));
    expect(await balanceOf(token, issuer.address)).toBe(RLUSD('9.7'));
    for (const p of paid) {
      const tx = await rpc<{ to: string; input: string; value: string; from: string }>('eth_getTransactionByHash', [p.txRef]);
      expect(tx.to.toLowerCase()).toBe(token.toLowerCase());
      expect(tx.from.toLowerCase()).toBe(issuer.address.toLowerCase());
      expect(BigInt(tx.value)).toBe(0n);
      expect(tx.input).toBe(transferData(p.merchantId === 'm-a' ? a : b, RLUSD(p.amountRlusd)).toLowerCase());
    }
    const rec = core.payoutHistory('m-b')[0];
    expect(verifyPayoutRecord(rec, core.publicKeys.claim)).toBe(true);
    expect(rec.payout.txRef).toBe(paid[1].txRef);
    expect(core.pendingPayouts()).toEqual([]);
  });

  it('partial failure: a line the issuer cannot cover stays unpaid and is paid once after a top-up', async () => {
    const token = await deployToken();
    await fundIssuer(token, '0.15');
    const [a, b] = [randomAddress(), randomAddress()];
    const core = await coreWithTabs({ 'm-a': 1, 'm-b': 2 });
    const job = new PayoutScheduler(core, rail(token, { 'm-a': a, 'm-b': b }), 1e9);
    expect((await job.runOnce()).map((p) => p.merchantId)).toEqual(['m-a']);
    expect(core.pendingPayouts()).toEqual([{ merchantId: 'm-b', amountTokens: 2, amountRlusd: '0.20' }]);
    await fundIssuer(token, '1');
    expect((await job.runOnce()).map((p) => p.merchantId)).toEqual(['m-b']);
    expect(await balanceOf(token, a)).toBe(RLUSD('0.1'));
    expect(await balanceOf(token, b)).toBe(RLUSD('0.2'));
  });

  it('an RPC that times out after sending: the receipt is found by hash and nothing is resent', async () => {
    const token = await deployToken();
    await fundIssuer(token, '1');
    const a = randomAddress();
    let sends = 0;
    const flaky = (async (url: string, init: RequestInit) => {
      const res = await fetch(url, init);
      if (JSON.parse(init.body as string).method === 'eth_sendRawTransaction') {
        sends++;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return res;
    }) as typeof fetch;
    const core = await coreWithTabs({ 'm-a': 1 });
    const nonceBefore = Number(BigInt(await rpc('eth_getTransactionCount', [issuer.address, 'latest'])));
    const paid = await new PayoutScheduler(core, rail(token, { 'm-a': a }, flaky), 1e9).runOnce();
    expect(paid.map((p) => p.merchantId)).toEqual(['m-a']);
    expect(sends).toBe(1);
    expect(Number(BigInt(await rpc('eth_getTransactionCount', [issuer.address, 'latest'])))).toBe(nonceBefore + 1);
    expect(await balanceOf(token, a)).toBe(RLUSD('0.1'));
  });

  it('a pending transfer is not resent; the tab is marked paid only once the block is mined', async () => {
    const token = await deployToken();
    await fundIssuer(token, '1');
    const a = randomAddress();
    const core = await coreWithTabs({ 'm-a': 1 });
    const job = new PayoutScheduler(core, rail(token, { 'm-a': a }, undefined, 100), 1e9);
    await rpc('evm_setAutomine', [false]);
    try {
      expect(await job.runOnce()).toEqual([]);
      expect(core.pendingPayouts()).toHaveLength(1);
      expect(await job.runOnce()).toEqual([]); // still pending: no second transfer is signed
      const pool = await rpc<{ pending: Record<string, Record<string, unknown>> }>('txpool_content');
      const mine = Object.entries(pool.pending).find(([k]) => k.toLowerCase() === issuer.address.toLowerCase())?.[1] ?? {};
      expect(Object.keys(mine)).toHaveLength(1);
      await rpc('evm_mine');
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    const paid = await job.runOnce();
    expect(paid.map((p) => p.merchantId)).toEqual(['m-a']);
    expect(await balanceOf(token, a)).toBe(RLUSD('0.1'));
    expect(core.pendingPayouts()).toEqual([]);
  });
});
