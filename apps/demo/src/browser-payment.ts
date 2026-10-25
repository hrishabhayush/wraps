import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeX402PaymentSignature } from '@ap4m/sdk';
import { JsonRpcProvider, Wallet, parseUnits, formatUnits } from 'ethers';

export interface PaidResource { id: string; description: string; url: string }
const LEGACY_OPERATION = 'xrp-research-1';

export function paymentConfig(env: NodeJS.ProcessEnv) {
  const required = ['AP4M_CHANNEL_ID', 'AP4M_STATE_DIR'];
  const missing = required.filter(key => !env[key]);
  if (!env.AP4M_RESOURCES && !env.AP4M_RESOURCE_URL) missing.push('AP4M_RESOURCE_URL or AP4M_RESOURCES');
  if (!env.AGENT_PRIVATE_KEY && !env.AP4M_AGENT_KEY_FILE) missing.push('AGENT_PRIVATE_KEY or AP4M_AGENT_KEY_FILE');
  const enabled = env.AP4M_ENABLE_PAYMENTS === '1';
  const maximum = env.AP4M_MAX_RLUSD ?? '1';
  if (!/^\d+(\.\d{1,18})?$/.test(maximum) || parseUnits(maximum, 18) <= 0n || parseUnits(maximum, 18) > parseUnits('1', 18)) {
    throw new Error('AP4M_MAX_RLUSD must be greater than zero and at most 1 for this demo');
  }
  const resources: PaidResource[] = env.AP4M_RESOURCES ? JSON.parse(env.AP4M_RESOURCES) : env.AP4M_RESOURCE_URL ? [{
    id: LEGACY_OPERATION, description: 'Saved XRPL EVM testnet block snapshot; not current prices or native XRPL data.', url: env.AP4M_RESOURCE_URL,
  }] : [];
  if (!Array.isArray(resources) || (env.AP4M_RESOURCES && !resources.length) || resources.length > 10) throw new Error('Configure between 1 and 10 AP4M resources');
  const ids = new Set<string>();
  for (const resource of resources) {
    if (!resource || typeof resource.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(resource.id)
      || ids.has(resource.id) || typeof resource.description !== 'string' || !resource.description.trim() || resource.description.length > 1000
      || typeof resource.url !== 'string') throw new Error('Invalid or duplicate AP4M resource');
    ids.add(resource.id);
    const url = new URL(resource.url);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.href !== resource.url || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || url.search || url.pathname !== '/resource') {
      throw new Error('AP4M resource must be HTTPS, or a loopback HTTP /resource URL');
    }
  }
  if (env.AP4M_CHANNEL_ID && !/^0x[0-9a-f]{64}$/.test(env.AP4M_CHANNEL_ID)) throw new Error('AP4M_CHANNEL_ID must be a lowercase bytes32 channel ID');
  return { enabled, ready: enabled && missing.length === 0, missing, maximum, resources, resourceUrl: resources[0]?.url };
}

/** The vendor toolkit validates the channel, price, voucher and exact confirmed redemption. */
export async function purchase(env: NodeJS.ProcessEnv, currentIp: string, expectedIp: string, publish: (type: string, message: string) => void, budget?: string, resourceId = LEGACY_OPERATION) {
  const cfg = paymentConfig(env);
  if (!cfg.ready) throw new Error('Real AP4M payments are disabled or channel configuration is incomplete');
  if (!expectedIp || currentIp !== expectedIp) throw new Error('Agent egress does not match the configured VPN exit; payment blocked');
  const resource = cfg.resources.find(item => item.id === resourceId);
  if (!resource) throw new Error('Unknown AP4M resource; payment blocked');
  const stateDirectory = resourceId === LEGACY_OPERATION ? env.AP4M_STATE_DIR! : join(env.AP4M_STATE_DIR!, resourceId);
  const maximum = budget ?? cfg.maximum;
  if (!/^\d+(\.\d{1,18})?$/.test(maximum) || parseUnits(maximum, 18) > parseUnits(cfg.maximum, 18)) throw new Error('Task budget exceeds the server payment limit');
  let retained, pendingResource: string | undefined;
  // Check old services too: changing the catalog must not bypass an unresolved voucher.
  let savedIds: string[] = [];
  try { savedIds = (await readdir(env.AP4M_STATE_DIR!, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const id of new Set([LEGACY_OPERATION, ...savedIds, ...cfg.resources.map(item => item.id)])) {
    const directory = id === LEGACY_OPERATION ? env.AP4M_STATE_DIR! : join(env.AP4M_STATE_DIR!, id);
    try {
      const record = JSON.parse(await readFile(join(directory, 'purchase.json'), 'utf8'));
      if (id === resourceId) retained = record;
      else if (record.complete !== true) pendingResource = id;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const identityMatches = retained?.intent?.channelId === env.AP4M_CHANNEL_ID && retained?.intent?.resourceUrl === resource.url
    && (retained?.intent?.operation === resourceId || /^purchase-[0-9a-f-]{36}$/.test(retained?.intent?.operation));
  if (retained && !identityMatches) throw new Error('Saved purchase belongs to another resource or channel; keep its state for recovery');
  // During recovery, skip completed services until the unresolved voucher is reached.
  const resume = retained && (retained.complete !== true || pendingResource);
  const alreadyPaid = Boolean(resume && retained.complete === true);
  if (alreadyPaid) {
    try {
      const cached = JSON.parse(await readFile(join(stateDirectory, 'result.json'), 'utf8'));
      if (cached.channelId === env.AP4M_CHANNEL_ID && cached.resourceUrl === resource.url) return { ...cached.result, spentRlusd: '0', cached: true };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!alreadyPaid && pendingResource) throw new Error(`Resume unresolved AP4M purchase ${pendingResource} before buying another resource`);
  if (!alreadyPaid && parseUnits(maximum, 18) === 0n) throw new Error('This task has a zero payment budget');
  if (resume && !alreadyPaid && BigInt(retained.intent.maximumAmount) > parseUnits(maximum, 18)) throw new Error('An unresolved payment needs its original budget; do not start a new purchase');
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
      context, provider, wallet, stateDirectory,
      resourceUrl: resource.url, channelId: env.AP4M_CHANNEL_ID!,
      maximumAmount: resume ? retained.intent.maximumAmount : parseUnits(maximum, 18).toString(),
      // The toolkit archives completed intents; unresolved vouchers keep their exact operation.
      operation: resume ? retained.intent.operation : `purchase-${randomUUID()}`,
      requestFetch: async (url: string, init: RequestInit) => {
        const signed = new Headers(init.headers).has('PAYMENT-SIGNATURE');
        publish(signed ? 'voucher' : 'request', signed ? `${resourceId}: signed AP4M voucher saved and sent in PAYMENT-SIGNATURE. Waiting for merchant redemption.` : `${resourceId}: requesting the merchant’s x402 challenge.`);
        const response = await fetch(url, init);
        publish('http', `Merchant returned HTTP ${response.status}${response.status === 402 ? ' Payment Required' : ''}.`);
        return response;
      },
    });
    publish('redemption', `${resourceId}: exact voucher redemption confirmed on-chain; paid service result received.`);
    const record = JSON.parse(await readFile(join(stateDirectory, 'purchase.json'), 'utf8'));
    const amount = decodeX402PaymentSignature(record.header).accepted.amount;
    const output = { ...result, amountWei: amount, spentRlusd: alreadyPaid ? '0' : formatUnits(amount, 18), cached: alreadyPaid };
    await writeFile(join(stateDirectory, 'result.json.tmp'), JSON.stringify({ channelId: env.AP4M_CHANNEL_ID, resourceUrl: resource.url, result: output }), { mode: 0o600 });
    await rename(join(stateDirectory, 'result.json.tmp'), join(stateDirectory, 'result.json'));
    return output;
  } finally { provider.destroy(); }
}
