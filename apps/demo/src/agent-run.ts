// The right pane: a local mock issuer and merchant, and one research task paid with blind tokens.
// The SDK reads the merchant's single-use quote (quoteId, resource) from each 402 and sends it
// back in the x-blindtoken-quote header. It checks the issuer's signed token key epochs on connect.
//
// Tamper mode points the agent at a second issuer built as 'issuer-tampered'. Its PCR0 differs,
// so the SDK must refuse it with PCR_MISMATCH before any top-up or purchase.
import { AttestationError, MockAttestationVerifier, b64u, generateEd25519, mockPcrs } from '@wraps/attestation';
import { ResearchAgent, DEMO_TASKS } from '@wraps/agent';
import { startIssuer } from '@wraps/issuer';
import { Merchant } from '@wraps/merchant';
import { MockTopUpWallet, PrivatePayClient } from '@wraps/sdk';

export type Publish = (type: string, data?: unknown) => void;

/** The verifier codes for "this is not the published build": mock / Nitro PCRs, Confidential Space image. */
const MEASUREMENT_MISMATCH = new Set(['PCR_MISMATCH', 'IMAGE_MISMATCH']);

/** True only for the attestation refusal a tampered build must cause. */
export function isTamperRefusal(err: unknown): err is AttestationError {
  return err instanceof AttestationError && MEASUREMENT_MISMATCH.has(err.code);
}

export interface AgentRunOptions {
  tamper?: boolean;
  /** For tests: replaces startIssuer. */
  startIssuer?: typeof startIssuer;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runPrivateAgent(publish: Publish, opts: AgentRunOptions = {}): Promise<void> {
  const tamper = opts.tamper ?? false;
  const start = opts.startIssuer ?? startIssuer;
  let issuer: Awaited<ReturnType<typeof startIssuer>> | undefined;
  let agentIssuer: Awaited<ReturnType<typeof startIssuer>> | undefined;
  let merchant: Merchant | undefined;
  try {
    publish('status', { message: tamper ? 'Starting trusted merchant and a tampered issuer build.' : 'Starting local mock issuer and merchant.' });
    const expectedPcrs = mockPcrs('issuer');
    const merchantId = 'merchant-research-data';
    const merchantAuthKey = generateEd25519();
    issuer = await start({
      payoutIntervalMs: 3_600_000,
      log: (m) => publish('issuer', { message: m }),
      merchantAuth: { publicKeys: { [merchantId]: b64u(merchantAuthKey.publicKeyBytes) } },
    });
    merchant = new Merchant({
      merchantId,
      issuerUrl: issuer.url,
      verifier: new MockAttestationVerifier({ expectedPcrs }),
      authPrivateKey: merchantAuthKey.privateKey,
      log: (m) => publish('merchant', { message: m }),
    });
    const merchantUrl = await merchant.start();
    if (tamper) {
      agentIssuer = await start({
        buildName: 'issuer-tampered',
        payoutIntervalMs: 3_600_000,
        log: (m) => publish('issuer', { message: `[tampered] ${m}` }),
      });
      publish('tamper', {
        message: 'The agent is pointed at an issuer rebuilt with a different code hash.',
        expectedPcr0: expectedPcrs['0'],
        actualPcr0: mockPcrs('issuer-tampered')['0'],
      });
    }
    const sdk = new PrivatePayClient({
      issuerUrl: (agentIssuer ?? issuer).url,
      verifier: new MockAttestationVerifier({ expectedPcrs }),
      wallet: new MockTopUpWallet(),
      caps: { perCallTokens: 5, dailyTokens: 24, maxTopUpTokens: 20 },
      onEvent: (event) => publish(`sdk:${event.type}`, event),
    });

    let attested;
    try {
      attested = await sdk.connect();
    } catch (err) {
      // Only the expected measurement mismatch counts as the tamper result. Anything else is an error.
      if (tamper && isTamperRefusal(err)) {
        publish('tamper-refused', { code: err.code, message: `SDK refused the issuer before top-up or purchases: ${err.message}` });
        return;
      }
      throw err;
    }
    if (tamper) throw new Error('the SDK accepted the tampered issuer; the tamper test failed');

    publish('status', {
      message: `Issuer attestation verified (${attested.attestation.format}, measurement ${attested.attestation.measurement.slice(0, 16)}…). Running a research task.`,
    });
    await new ResearchAgent({
      sdk,
      merchantUrl,
      print: (m) => publish('reasoning', { message: m }),
    }).run([DEMO_TASKS[0]]);
    publish('complete', { message: 'The local private-payment task finished.' });
  } catch (err) {
    publish('error', { message: message(err) });
  } finally {
    await merchant?.close();
    await agentIssuer?.close();
    await issuer?.close();
  }
}
