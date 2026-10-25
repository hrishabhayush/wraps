// Picks the attestation verifier from the environment, for the CLIs and demos.
//   ATTESTATION=mock (default)          MockAttestationVerifier, expecting the mock 'issuer' build
//   ATTESTATION=confidential-space      ConfidentialSpaceVerifier, policy from EXPECTED_JSON
//   EXPECTED_JSON=infra/gcp/expected.json (default)
import { resolve } from 'node:path';
import { ConfidentialSpaceVerifier, loadConfidentialSpacePolicy } from './confidential-space';
import { MockAttestationVerifier, mockPcrs } from './mock';
import type { AttestationVerifier } from './types';

export function verifierFromEnv(role: 'issuer' | 'relay' = 'issuer', env = process.env): AttestationVerifier {
  const mode = env.ATTESTATION ?? 'mock';
  if (mode === 'mock') return new MockAttestationVerifier({ expectedPcrs: mockPcrs(role) });
  if (mode === 'confidential-space') {
    const path = resolve(env.EXPECTED_JSON ?? 'infra/gcp/expected.json');
    return new ConfidentialSpaceVerifier(loadConfidentialSpacePolicy(path, role));
  }
  throw new Error(`ATTESTATION must be mock or confidential-space, got ${mode}`);
}
