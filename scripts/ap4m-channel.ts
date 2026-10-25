// Opens only a channel; never signs a payment voucher, settles, or closes it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider, Wallet, Transaction, keccak256, parseEther } from 'ethers';
import { ap4mSession } from '../apps/demo/src/ap4m-account';
import { CHANNEL_CAP, validateChannelRequest } from '../apps/demo/src/ap4m-channel';

const key = (process.env.AGENT_PRIVATE_KEY ?? '').trim();
delete process.env.AGENT_PRIVATE_KEY;
let provider: JsonRpcProvider | undefined;
try {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error('Load and export AGENT_PRIVATE_KEY in this terminal first.');
  provider = new JsonRpcProvider('https://rpc.testnet.xrplevm.org');
  if ((await provider.getNetwork()).chainId !== 1449000n) throw new Error('Wrong network; expected XRPL EVM testnet.');
  const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
  const session = await ap4mSession(wallet, process.env.TEAM_NAME || 'CBC');
  const list = async () => {
    const data = await session.call('/public/participant/channels');
    if (!Array.isArray(data.channels)) throw new Error('Invalid channel list');
    return data.channels as { channel_id: string; channel_status: string; cap_wei: string; merchant_id: string; payout: string }[];
  };
  const active = (await list()).filter(c => c.channel_status !== 'closed' && c.channel_status !== 'failed');
  if (active.length) {
    for (const c of active) console.log(JSON.stringify({ channelId: c.channel_id, status: c.channel_status, capWei: c.cap_wei, merchantId: c.merchant_id, payout: c.payout }, null, 2));
    console.log('Existing channel/request found; no new transaction sent.');
  } else {
    const dir = join(homedir(), '.local', 'state', 'wraps', 'ap4m', wallet.address.toLowerCase());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stateFile = join(dir, 'channel-request.json');
    let state: { raw: string; hash: string };
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const prepared = await session.call('/public/participant/channel-requests/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cap_rlusd: '1' }),
      });
      const tx = await wallet.populateTransaction(validateChannelRequest(prepared));
      const maximumGas = BigInt(tx.gasLimit ?? 0) * BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? 0);
      if (maximumGas <= 0n || maximumGas > parseEther('0.1')) throw new Error('Estimated gas exceeds this demo’s 0.1 testnet XRP ceiling. Nothing sent.');
      const raw = await wallet.signTransaction(tx);
      state = { raw, hash: keccak256(raw) };
      // Exclusive creation also prevents two simultaneous runs from submitting two requests.
      await writeFile(stateFile, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    }
    const retained = Transaction.from(state.raw);
    if (retained.chainId !== 1449000n || retained.from?.toLowerCase() !== wallet.address.toLowerCase() || keccak256(state.raw) !== state.hash) {
      throw new Error('Retained channel request does not match this agent or network.');
    }
    validateChannelRequest({ to: retained.to, data: retained.data, value: retained.value });
    console.log(`Opening a channel capped at 1 RLUSD for ${wallet.address}. No merchant purchase.`);
    console.log(`Request transaction: ${state.hash}`);
    console.log(`Retry state: ${stateFile}`);
    if (!await provider.getTransaction(state.hash)) {
      try { await provider.broadcastTransaction(state.raw); }
      catch { throw new Error(`Broadcast uncertain. Retry this command using the saved request ${state.hash}; do not delete the state file.`); }
    }
    const receipt = await provider.waitForTransaction(state.hash, 1, 90000);
    if (!receipt) throw new Error('Request still pending. Retry this same command later.');
    if (receipt.status !== 1) throw new Error('Channel request reverted. No new request will be sent automatically.');
    const known = await list();
    let channel = known.find(c => c.channel_status === 'open' && BigInt(c.cap_wei) === CHANNEL_CAP);
    if (!channel) channel = await session.call('/public/participant/channel-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tx_hash: state.hash }),
    });
    if (!channel || typeof channel.channel_id !== 'string') throw new Error('Request confirmed, but the service returned no channel ID. Run ap4m:check.');
    const channelId = channel.channel_id;
    for (let attempt = 0; channel.channel_status !== 'open' && attempt < 60; attempt++) {
      if (channel.channel_status === 'failed') throw new Error('The service could not open the channel. Run ap4m:check.');
      await new Promise(resolve => setTimeout(resolve, 2000));
      channel = (await list()).find(c => c.channel_id === channelId) ?? channel;
    }
    if (channel.channel_status !== 'open') throw new Error(`Channel ${channelId} is still ${channel.channel_status}. Run ap4m:check later; do not create another request.`);
    if (BigInt(channel.cap_wei) !== CHANNEL_CAP) throw new Error('Reported channel cap differs from the requested 1 RLUSD. Do not pay.');
    console.log(JSON.stringify({ channelId, status: channel.channel_status, capRlusd: '1', merchantId: channel.merchant_id, payout: channel.payout }, null, 2));
    console.log('Channel ready. No payment voucher signed; no merchant purchase made.');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Channel setup failed';
  console.error(key ? message.split(key).join('[redacted]') : message);
  process.exitCode = 1;
} finally { provider?.destroy(); }
