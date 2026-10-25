// Types for the parts of the official AP4M toolkit (x402.mjs, vendored unchanged) that the issuer uses.
import type { Provider, Signer, Wallet } from 'ethers';
import type { ParticipantRequestContext } from '@ap4m/sdk/participant-requests';

export interface X402Context {
  network: string;
  participantRequest: ParticipantRequestContext;
  x402: { token: string; validBefore: number; merchant: { environmentManifestDigest: string } };
}

export function loadX402Context(apiUrl: string): Promise<X402Context>;

export function buyResource(options: {
  context: X402Context;
  provider: Provider;
  wallet: Wallet;
  stateDirectory: string;
  resourceUrl: string;
  channelId: string;
  maximumAmount: string;
  operation: string;
  requestFetch?: typeof fetch;
}): Promise<{ operation: string; claimId: string; transactionHash: string; redemption: 'Confirmed'; resource: unknown }>;

export function createX402Merchant(config: {
  context: X402Context;
  provider: Provider;
  submitter: Pick<Signer, 'sendTransaction'>;
  stateDirectory: string;
  resourceUrl: string;
  merchantParticipantId: string;
  payout: string;
  amount: string;
  content: Record<string, unknown>;
  cutoffMarginSeconds?: number;
  clock?: () => number;
}): { server: import('node:http').Server; close: () => Promise<void> };
