// The right pane: a local mock issuer and merchant, and one research task paid with blind tokens.
// The SDK reads the merchant's single-use quote (quoteId, resource) from each 402 and sends it
// back in the x-blindtoken-quote header. It checks the issuer's signed token key epochs on connect.
import { MockAttestationVerifier, mockPcrs } from '@wraps/attestation';
import { ResearchAgent, DEMO_TASKS } from '@wraps/agent';
import { startIssuer } from '@wraps/issuer';
import { Merchant } from '@wraps/merchant';
import { MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';

export type Publish = (type: string, data?: unknown) => void;

export async function runPrivateAgent(publish: Publish): Promise<void> {
  let issuer: Awaited<ReturnType<typeof startIssuer>> | undefined;
  let merchant: Merchant | undefined;
  try {
    publish('status', { message: 'Starting local mock issuer and merchant.' });
    const expectedPcrs = mockPcrs('issuer');
    issuer = await startIssuer({
      payoutIntervalMs: 3_600_000,
      log: (message) => publish('issuer', { message }),
    });
    merchant = new Merchant({
      issuerUrl: issuer.url,
      verifier: new MockAttestationVerifier({ expectedPcrs }),
      log: (message) => publish('merchant', { message }),
    });
    const merchantUrl = await merchant.start();
    const sdk = new PrivatePayClient({
      issuerUrl: issuer.url,
      verifier: new MockAttestationVerifier({ expectedPcrs }),
      wallet: new MockTopUpWallet(),
      caps: { perCallTokens: 5, dailyTokens: 24, maxTopUpTokens: 20 },
      onEvent: (event) => publish(`sdk:${event.type}`, event),
    });
    const attested = await sdk.connect();
    publish('status', {
      message: `Issuer attestation verified (${attested.attestation.format}, measurement ${attested.attestation.measurement.slice(0, 16)}…). Running a research task.`,
    });
    await new ResearchAgent({
      sdk,
      merchantUrl,
      print: (message) => publish('reasoning', { message }),
    }).run([DEMO_TASKS[0]]);
    publish('complete', { message: 'The local private-payment task finished.' });
  } catch (err) {
    publish('error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    await merchant?.close();
    await issuer?.close();
  }
}
