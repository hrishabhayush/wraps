import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeX402PaymentSignature } from '@ap4m/sdk';
import { JsonRpcProvider, Wallet, parseUnits, formatUnits } from 'ethers';

export function paymentConfig(env: NodeJS.ProcessEnv) {
  const required = ['AP4M_RESOURCE_URL', 'AP4M_CHANNEL_ID', 'AP4M_STATE_DIR'];
  const missing = required.filter(key => !env[key]);
  if (!env.AGENT_PRIVATE_KEY && !env.AP4M_AGENT_KEY_FILE) missing.push('AGENT_PRIVATE_KEY or AP4M_AGENT_KEY_FILE');
  const enabled = env.AP4M_ENABLE_PAYMENTS === '1';
  const maximum = env.AP4M_MAX_RLUSD ?? '1';
  if (!/^\d+(\.\d{1,18})?$/.test(maximum) || parseUnits(maximum, 18) <= 0n || parseUnits(maximum, 18) > parseUnits('1', 18)) {
    throw new Error('AP4M_MAX_RLUSD must be greater than zero and at most 1 for this demo');
  }
  if (env.AP4M_RESOURCE_URL) {
    const url = new URL(env.AP4M_RESOURCE_URL);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || url.search || url.pathname !== '/resource') {
      throw new Error('AP4M_RESOURCE_URL must be HTTPS, or a loopback HTTP /resource URL');
    }
  }
  if (env.AP4M_CHANNEL_ID && !/^0x[0-9a-f]{64}$/.test(env.AP4M_CHANNEL_ID)) throw new Error('AP4M_CHANNEL_ID must be a lowercase bytes32 channel ID');
  return { enabled, ready: enabled && missing.length === 0, missing, maximum, resourceUrl: env.AP4M_RESOURCE_URL };
}

/** The vendor toolkit validates the channel, price, voucher and exact confirmed redemption. */
export async function purchase(env: NodeJS.ProcessEnv, currentIp: string, expectedIp: string, publish: (type: string, message: string) => void, budget?: string) {
  const cfg = paymentConfig(env);
  if (!cfg.ready) throw new Error('Real AP4M payments are disabled or channel configuration is incomplete');
  if (!expectedIp || currentIp !== expectedIp) throw new Error('Agent egress does not match the configured VPN exit; payment blocked');
  const maximum = budget ?? cfg.maximum;
  if (!/^\d+(\.\d{1,18})?$/.test(maximum) || parseUnits(maximum, 18) > parseUnits(cfg.maximum, 18)) throw new Error('Task budget exceeds the server payment limit');
  let retained;
  try { retained = JSON.parse(await readFile(join(env.AP4M_STATE_DIR!, 'purchase.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const identityMatches = retained?.intent?.channelId === env.AP4M_CHANNEL_ID && retained?.intent?.resourceUrl === cfg.resourceUrl && retained?.intent?.operation === 'xrp-research-1';
  if (retained && !identityMatches) throw new Error('Saved purchase belongs to another resource or channel; keep its state for recovery');
  const alreadyPaid = retained?.complete === true;
  if (alreadyPaid) {
    try {
      const cached = JSON.parse(await readFile(join(env.AP4M_STATE_DIR!, 'result.json'), 'utf8'));
      if (cached.channelId === env.AP4M_CHANNEL_ID && cached.resourceUrl === cfg.resourceUrl) return { ...cached.result, spentRlusd: '0', cached: true };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!alreadyPaid && parseUnits(maximum, 18) === 0n) throw new Error('This task has a zero payment budget');
  if (retained && !alreadyPaid && retained.intent.maximumAmount !== parseUnits(maximum, 18).toString()) throw new Error('An unresolved payment must resume with its original budget; do not start a new purchase');
  let key = env.AGENT_PRIVATE_KEY?.trim();
  if (!key) {
    const keyFile = env.AP4M_AGENT_KEY_FILE!;
    const info = await stat(keyFile);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Agent key file must be private (chmod 600)');
    key = (await readFile(keyFile, 'utf8')).trim();
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error('Agent key must be a hex private key');
  if (!key.startsWith('0x')) key = `0x${key}`;
  // Official hackathon sample; the signed intent is retained privately for retry safety.
  // @ts-expect-error Official AP4M sample is distributed as JavaScript without declarations.
  const { loadX402Context, buyResource } = await import('../vendor/ap4m/x402.mjs');
  const context = await loadX402Context('https://hackathon.ap4m.build');
  const provider = new JsonRpcProvider('https://rpc.testnet.xrplevm.org');
  try {
    const wallet = new Wallet(key, provider);
    const result = await buyResource({
      context, provider, wallet, stateDirectory: env.AP4M_STATE_DIR!,
      resourceUrl: cfg.resourceUrl!, channelId: env.AP4M_CHANNEL_ID!,
      maximumAmount: alreadyPaid ? retained.intent.maximumAmount : parseUnits(maximum, 18).toString(),
      // Re-running this demo resumes this same purchase; it never invents a new payment intent.
      operation: 'xrp-research-1',
      requestFetch: async (url: string, init: RequestInit) => {
        const signed = new Headers(init.headers).has('PAYMENT-SIGNATURE');
        publish(signed ? 'voucher' : 'request', signed ? 'Signed AP4M voucher sent to the merchant. Waiting for redemption.' : 'Requesting the merchant’s x402 challenge.');
        const response = await fetch(url, init);
        publish('http', `Merchant returned HTTP ${response.status}${response.status === 402 ? ' Payment Required' : ''}.`);
        return response;
      },
    });
    const record = JSON.parse(await readFile(join(env.AP4M_STATE_DIR!, 'purchase.json'), 'utf8'));
    const amount = decodeX402PaymentSignature(record.header).accepted.amount;
    const output = { ...result, amountWei: amount, spentRlusd: alreadyPaid ? '0' : formatUnits(amount, 18), cached: alreadyPaid };
    await writeFile(join(env.AP4M_STATE_DIR!, 'result.json'), JSON.stringify({ channelId: env.AP4M_CHANNEL_ID, resourceUrl: cfg.resourceUrl, result: output }), { mode: 0o600 });
    return output;
  } finally { provider.destroy(); }
}
