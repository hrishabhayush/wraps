import { describe, expect, it } from 'vitest';
import { createConfidentialSpaceAccessTokenProvider, readConfidentialSecret } from '../src/confidential-secret';

describe('Confidential Space Secret Manager access', () => {
  const version = 'projects/wraps-hack/secrets/relay-auth/versions/1';
  const provider = 'projects/123456789012/locations/global/workloadIdentityPools/wraps-prod/providers/confidential-space';

  it('exchanges an attestation token and reads only the configured secret version', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input) === 'https://sts.googleapis.com/v1/token') {
        return new Response(JSON.stringify({ access_token: 'short-lived-access-token' }), { status: 200 });
      }
      return new Response(JSON.stringify({ payload: { data: Buffer.from('relay-secret').toString('base64') } }), { status: 200 });
    }) as typeof fetch;

    await expect(readConfidentialSecret(version, provider, {
      fetchImpl,
      getAttestationToken: async () => 'attested-workload-token',
    })).resolves.toBe('relay-secret');

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://sts.googleapis.com/v1/token');
    expect(calls[0].init?.body).toBeInstanceOf(URLSearchParams);
    const exchange = calls[0].init?.body as URLSearchParams;
    expect(exchange.get('audience')).toBe(`//iam.googleapis.com/${provider}`);
    expect(exchange.get('subject_token')).toBe('attested-workload-token');
    expect(calls[1].url).toBe(`https://secretmanager.googleapis.com/v1/${version}:access`);
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer short-lived-access-token');
  });

  it('rejects malformed resource names before requesting an attestation token', async () => {
    let requestedToken = false;
    await expect(readConfidentialSecret('projects/wraps-hack/secrets/relay-auth', provider, {
      getAttestationToken: async () => { requestedToken = true; return 'unused'; },
    })).rejects.toThrow('Secret Manager version must be');
    expect(requestedToken).toBe(false);
    await expect(readConfidentialSecret('projects/wraps-hack/secrets/relay-auth/versions/latest', provider, {
      getAttestationToken: async () => 'unused',
    })).rejects.toThrow('Secret Manager version must be');
  });

  it('sanitizes Secret Manager failures so response bodies cannot leak', async () => {
    const fetchImpl = (async () => new Response('contains-sensitive-provider-detail', { status: 403 })) as typeof fetch;
    await expect(readConfidentialSecret(version, provider, {
      fetchImpl,
      getAccessToken: async () => 'short-lived-access-token',
    })).rejects.toThrow('could not read the configured Secret Manager version');
  });

  it('caches and shares direct WIF access tokens until shortly before expiry', async () => {
    let now = 10_000;
    let tokenRequests = 0;
    let attestationRequests = 0;
    const fetchImpl = (async () => {
      tokenRequests++;
      return new Response(JSON.stringify({ access_token: `access-${tokenRequests}`, expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const getAccessToken = createConfidentialSpaceAccessTokenProvider(provider, {
      fetchImpl,
      now: () => now,
      getAttestationToken: async () => `attestation-${++attestationRequests}`,
    });

    await expect(Promise.all([getAccessToken(), getAccessToken()])).resolves.toEqual(['access-1', 'access-1']);
    await expect(getAccessToken()).resolves.toBe('access-1');
    expect(tokenRequests).toBe(1);
    expect(attestationRequests).toBe(1);

    now += 3_565_001;
    await expect(getAccessToken()).resolves.toBe('access-2');
    expect(tokenRequests).toBe(2);
    expect(attestationRequests).toBe(2);
  });
});
