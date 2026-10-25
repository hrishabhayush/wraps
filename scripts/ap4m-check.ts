import { Wallet } from 'ethers';
import { checkAp4mAccount } from '../apps/demo/src/ap4m-account';

const supplied = process.env.AGENT_PRIVATE_KEY?.trim() ?? '';
delete process.env.AGENT_PRIVATE_KEY;
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(supplied)) {
  console.error('AGENT_PRIVATE_KEY is missing or malformed. Run this in the same terminal where you loaded and exported it.');
  process.exitCode = 1;
} else {
  try {
    const wallet = new Wallet(supplied.startsWith('0x') ? supplied : `0x${supplied}`);
    console.log(`Checking AP4M registration for agent ${wallet.address} (no payment or channel creation).`);
    const result = await checkAp4mAccount(wallet, process.env.TEAM_NAME || 'CBC');
    console.log(JSON.stringify(result, null, 2));
    if (!result.channels.length) console.log('Signed in successfully. No channels exist yet.');
  } catch (error) {
    console.error(error instanceof Error ? error.message.split(supplied).join('[redacted]') : 'AP4M account check failed');
    process.exitCode = 1;
  }
}
