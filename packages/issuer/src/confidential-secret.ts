import { randomBytes } from 'node:crypto';
import { ConfidentialSpaceProvider } from '@wraps/attestation';

const STS_URL = 'https://sts.googleapis.com/v1/token';
const SECRET_MANAGER_URL = 'https://secretmanager.googleapis.com/v1';
const STS_AUDIENCE = 'https://sts.googleapis.com';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface ConfidentialSecretOptions {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  /** Test seam; production callers use a token from the Confidential Space launcher. */
  getAttestationToken?: () => Promise<string>;
}

export interface ConfidentialAccessTokenOptions {
  fetchImpl?: typeof fetch;
  /** Test seam; production callers use a token from the Confidential Space launcher. */
  getAttestationToken?: () => Promise<string>;
  now?: () => number;
}

/** Create a cached OAuth token source for direct WIF access to protected Google Cloud resources. */
export function createConfidentialSpaceAccessTokenProvider(
  workloadIdentityProvider: string,
  options: ConfidentialAccessTokenOptions = {},
): () => Promise<string> {
  const providerPath = validateWorkloadIdentityProvider(workloadIdentityProvider);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const getToken = options.getAttestationToken ?? (async () => new ConfidentialSpaceProvider({ audience: STS_AUDIENCE })
    .attest(randomBytes(16), randomBytes(32)));
  let cachedToken: string | undefined;
  let refreshAt = 0;
  let pending: Promise<{ accessToken: string; refreshAt: number }> | undefined;

  return async () => {
    if (cachedToken && refreshAt > now() + 5_000) return cachedToken;
    pending ??= (async () => {
      try {
        const subjectToken = await getToken();
        const exchange = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          audience: `//iam.googleapis.com/${providerPath}`,
          scope: CLOUD_PLATFORM_SCOPE,
          requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          subject_token: subjectToken,
        });
        const response = await fetchImpl(STS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: exchange,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('token exchange rejected');
        const result = await response.json() as { access_token?: unknown; expires_in?: unknown };
        if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('token exchange returned no access token');
        const expiresIn = Number(result.expires_in);
        const tokenRefreshAt = Number.isSafeInteger(expiresIn) && expiresIn > 30
          ? now() + (expiresIn - 30) * 1000
          : now();
        return { accessToken: result.access_token, refreshAt: tokenRefreshAt };
      } catch {
        throw new Error('could not exchange the Confidential Space token for Google Cloud access');
      }
    })();
    try {
      const token = await pending;
      cachedToken = token.accessToken;
      refreshAt = token.refreshAt;
      return token.accessToken;
    } finally {
      pending = undefined;
    }
  };
}

/** Read a Secret Manager version as an attested Confidential Space workload using direct WIF access. */
export async function readConfidentialSecret(
  secretVersion: string,
  workloadIdentityProvider: string,
  options: ConfidentialSecretOptions = {},
): Promise<string> {
  const secretPath = validateSecretVersion(secretVersion);
  validateWorkloadIdentityProvider(workloadIdentityProvider);
  let accessToken: string;
  try {
    accessToken = options.getAccessToken
      ? await options.getAccessToken()
      : await createConfidentialSpaceAccessTokenProvider(workloadIdentityProvider, options)();
    if (!accessToken) throw new Error('empty access token');
  } catch {
    throw new Error('could not obtain a Confidential Space access token for Secret Manager');
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${SECRET_MANAGER_URL}/${secretPath}:access`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('secret access rejected');
    const result = await response.json() as { payload?: { data?: unknown } };
    if (typeof result.payload?.data !== 'string' || !result.payload.data) throw new Error('secret payload is missing');
    const bytes = Buffer.from(result.payload.data, 'base64');
    if (bytes.toString('base64') !== result.payload.data) throw new Error('secret payload is not canonical base64');
    return bytes.toString('utf8');
  } catch {
    throw new Error('could not read the configured Secret Manager version');
  }
}

function validateSecretVersion(value: string): string {
  const match = /^projects\/([A-Za-z0-9][A-Za-z0-9.-]{0,62})\/secrets\/([A-Za-z0-9_-]{1,255})\/versions\/([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error('Secret Manager version must be projects/<project>/secrets/<secret>/versions/<version>');
  return value;
}

function validateWorkloadIdentityProvider(value: string): string {
  const match = /^projects\/([0-9]+)\/locations\/global\/workloadIdentityPools\/([A-Za-z0-9_-]{1,32})\/providers\/([A-Za-z0-9_-]{1,32})$/.exec(value);
  if (!match) throw new Error('GCP_WIF_PROVIDER must name a global workload identity pool provider');
  return value;
}
