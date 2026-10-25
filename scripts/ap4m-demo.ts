// A local AP4M merchant + dashboard. Startup signs in but makes no purchase.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { JsonRpcProvider, Wallet, parseUnits, parseEther, formatEther } from 'ethers';
import { PARTICIPANT_LEDGER_INTERFACE } from '@ap4m/sdk';
import { readParticipantPaymentChannel } from '@ap4m/sdk/participant-requests';
import { ap4mSession } from '../apps/demo/src/ap4m-account';
import { AP4M_TASK_RESOURCES } from '../apps/demo/src/ap4m-task';

const task = process.argv.includes('--task');
if (task && process.env.WRAPS_SPONSORED === '1') throw new Error('The three-service task is local only; use ap4m:demo for sponsored runs.');
const key = (process.env.AGENT_PRIVATE_KEY ?? '').trim();
delete process.env.AGENT_PRIVATE_KEY;
let provider: JsonRpcProvider | undefined, child: ChildProcess | undefined;
const merchants: { server: Server; close(): Promise<void> }[] = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  child?.kill('SIGTERM');
  await Promise.all(merchants.map(merchant => merchant.close()));
  provider?.destroy();
}
try {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error('Run this in the terminal where AGENT_PRIVATE_KEY is exported.');
  provider = new JsonRpcProvider('https://rpc.testnet.xrplevm.org');
  if ((await provider.getNetwork()).chainId !== 1449000n) throw new Error('Expected XRPL EVM testnet');
  const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
  const session = await ap4mSession(wallet, process.env.TEAM_NAME || 'CBC');
  const { channels } = await session.call('/public/participant/channels');
  if (!Array.isArray(channels)) throw new Error('Invalid AP4M channel response');
  const candidates = channels.filter(c => c.channel_status === 'open' && (!process.env.AP4M_CHANNEL_ID || c.channel_id === process.env.AP4M_CHANNEL_ID));
  if (candidates.length !== 1) throw new Error('Expected exactly one open channel. Run ap4m:check, then set AP4M_CHANNEL_ID if needed.');
  if (typeof candidates[0].channel_id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(candidates[0].channel_id)) throw new Error('AP4M returned an invalid channel ID');
  const channelId = candidates[0].channel_id as `0x${string}`;
  // @ts-expect-error Official AP4M JavaScript sample has no TypeScript declarations.
  const { loadX402Context, createX402Merchant } = await import('../apps/demo/vendor/ap4m/x402.mjs');
  const context = await loadX402Context('https://hackathon.ap4m.build');
  const channel = await readParticipantPaymentChannel(provider, context.participantRequest, channelId);
  if (channel.agent.toLowerCase() !== wallet.address.toLowerCase() || channel.status !== 1 || BigInt(channel.cap) > parseUnits('1', 18)) {
    throw new Error('Channel must belong to this agent, be open, and have a cap no larger than 1 RLUSD.');
  }
  const directory = join(homedir(), '.local', 'state', 'wraps', 'ap4m', wallet.address.toLowerCase(), channelId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Retain the exact report and URL: an uncertain payment must retrieve the same resource on retry.
  const reportPath = join(directory, 'network-report.json');
  let report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const block = await provider.getBlock('latest');
    if (!block) throw new Error('Could not read a network snapshot');
    report = { title: 'XRPL EVM network snapshot', network: 'XRPL EVM Testnet', chainId: 1449000,
      source: 'https://rpc.testnet.xrplevm.org', block: block.number, timestamp: new Date(block.timestamp * 1000).toISOString(),
      transactionCount: block.transactions.length, gasUsed: block.gasUsed.toString(), gasLimit: block.gasLimit.toString(),
      note: 'Saved demo research snapshot, not a current market-price feed.' };
    await writeFile(reportPath, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
  }
  const resources = task ? AP4M_TASK_RESOURCES : AP4M_TASK_RESOURCES.slice(0, 1);
  const reports = [report];
  if (task) {
    reports.push({ title: 'XRPL EVM gas utilization', network: report.network, block: report.block, timestamp: report.timestamp,
      source: report.source, gasUsed: report.gasUsed, gasLimit: report.gasLimit,
      utilizationPercent: Number(BigInt(report.gasUsed) * 10000n / BigInt(report.gasLimit)) / 100,
      note: 'Derived from the saved block snapshot; not live network utilization.' });
    const feePath = join(directory, 'fee-estimate.json');
    let feeReport;
    try { feeReport = JSON.parse(await readFile(feePath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const fees = await provider.getFeeData();
      if (fees.gasPrice === null) throw new Error('Could not read the testnet gas price');
      feeReport = { title: 'XRPL EVM native transfer fee estimate', network: 'XRPL EVM Testnet',
        source: 'https://rpc.testnet.xrplevm.org', timestamp: new Date().toISOString(),
        gasPriceWei: fees.gasPrice.toString(), transferGas: '21000', estimatedFeeXrp: formatEther(fees.gasPrice * 21000n),
        note: 'Saved estimate for a plain native XRP transfer to an externally owned account. Not an RLUSD transfer or current fee quote.' };
      await writeFile(feePath, JSON.stringify(feeReport), { mode: 0o600, flag: 'wx' });
    }
    reports.push(feeReport);
  }
  const amount = parseUnits('0.05', 18);
  // This local demo uses the agent wallet for redemption gas as well; payout still goes to the channel merchant.
  const submitter = {
    sendTransaction: async (tx: { to: string; data: string; value: bigint }) => {
      const call = PARTICIPANT_LEDGER_INTERFACE.parseTransaction({ data: tx.data });
      if (tx.to.toLowerCase() !== context.participantRequest.ledger.toLowerCase() || tx.value !== 0n
        || call?.name !== 'redeemVoucher' || call.args[0].channelId !== channelId
        || BigInt(call.args[0].cumulativeAmount) > BigInt(channel.cap)) throw new Error('Refused unexpected merchant redemption');
      const populated = await wallet.populateTransaction(tx);
      const gas = BigInt(populated.gasLimit ?? 0) * BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0);
      if (gas <= 0n || gas > parseEther('0.1')) throw new Error('Redemption gas exceeds the 0.1 testnet XRP ceiling');
      return wallet.sendTransaction(populated);
    },
  };
  for (const [index, resource] of resources.entries()) {
    const merchant = createX402Merchant({ context, provider, submitter,
      stateDirectory: join(directory, index === 0 ? 'merchant' : `merchant-${resource.id}`),
      resourceUrl: resource.url, merchantParticipantId: channel.merchantId, payout: channel.payout, amount: amount.toString(), content: reports[index] });
    merchants.push(merchant);
    await new Promise<void>((resolve, reject) => { merchant.server.once('error', reject); merchant.server.listen(Number(new URL(resource.url).port), '127.0.0.1', resolve); });
    console.log(`Merchant ready: ${resource.url} — ${resource.description}`);
  }
  console.log(`Price per service: 0.05 testnet RLUSD. Task ceiling: ${task ? '0.15' : '0.05'} RLUSD. Payout: ${channel.payout}. Channel: ${channelId}`);
  console.log('Dashboard: http://127.0.0.1:4177 — review the task and budget, then Run. Startup makes no purchase.');
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/demo/src/browser-server.ts'], {
    cwd: new URL('..', import.meta.url), stdio: 'inherit', env: { ...process.env,
      AGENT_PRIVATE_KEY: key, AP4M_CHANNEL_ID: channelId, AP4M_RESOURCE_URL: resources[0].url,
      AP4M_RESOURCES: JSON.stringify(resources), AP4M_DEMO_TASK: task ? '1' : '0',
      AP4M_STATE_DIR: join(directory, 'agent'), AP4M_MAX_RLUSD: task ? '0.15' : '0.05', AP4M_ENABLE_PAYMENTS: '1', BROWSER_DEMO_PORT: '4177',
    },
  });
  child.once('error', () => { console.error('Could not launch the dashboard'); void close(); });
  child.once('exit', code => { process.exitCode = code ?? 0; void close(); });
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch (error) {
  const message = error instanceof Error ? error.message : 'AP4M demo startup failed';
  console.error(key ? message.split(key).join('[redacted]') : message);
  process.exitCode = 1;
  await close();
}
