import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isIssuerStateSnapshot, type IssuerStateSnapshot, type IssuerStateStore } from './state-store';

const STORAGE_API = 'https://storage.googleapis.com/storage/v1';
const STORAGE_UPLOAD_API = 'https://storage.googleapis.com/upload/storage/v1';
const KMS_API = 'https://cloudkms.googleapis.com/v1';
const MAX_SEQUENCE = BigInt(Number.MAX_SAFE_INTEGER);
const SEQUENCE_WIDTH = String(Number.MAX_SAFE_INTEGER).length;
const OBJECT_PREFIX_DEFAULT = 'issuer-state/v1';

export interface GcsIssuerStateStoreOptions {
  bucket: string;
  /** Symmetric Cloud KMS key resource. The caller must supply an attestation-bound access token source. */
  kmsKey: string;
  getAccessToken: () => Promise<string>;
  /** Defaults to `issuer-state/v1`. Keep this prefix dedicated to one issuer state stream. */
  objectPrefix?: string;
  fetchImpl?: typeof fetch;
}

interface EncryptedSnapshot {
  version: 1;
  sequence: number;
  algorithm: 'AES-256-GCM';
  keyEncryption: 'GCP-KMS';
  kmsKey: string;
  wrappedDataKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Append-only encrypted issuer snapshots in Cloud Storage.
 *
 * Each snapshot uses a fresh local AES-256-GCM data key wrapped by Cloud KMS. Objects are
 * immutable and sequence-named; the workload only needs GCS object create/get/list permissions,
 * never delete or overwrite. A create-only precondition makes two issuers that loaded the same
 * state race safely: one append wins and the stale writer fails before acknowledging its update.
 */
export class GcsIssuerStateStore implements IssuerStateStore {
  readonly mode = 'gcs-kms-encrypted' as const;
  private readonly bucket: string;
  private readonly kmsKey: string;
  private readonly objectPrefix: string;
  private readonly fetchImpl: typeof fetch;
  private loaded = false;
  private sequence = 0;

  constructor(private readonly options: GcsIssuerStateStoreOptions) {
    if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes('..') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(options.bucket)) {
      throw new Error('ISSUER_STATE_GCS_BUCKET must be a valid bucket name');
    }
    this.bucket = options.bucket;
    this.kmsKey = validateKmsKey(options.kmsKey);
    this.objectPrefix = validateObjectPrefix(options.objectPrefix ?? OBJECT_PREFIX_DEFAULT);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async load(): Promise<IssuerStateSnapshot | undefined> {
    this.loaded = false;
    try {
      const token = await this.options.getAccessToken();
      const listUrl = new URL(`${STORAGE_API}/b/${encodeURIComponent(this.bucket)}/o`);
      listUrl.searchParams.set('prefix', `${this.objectPrefix}/`);
      listUrl.searchParams.set('maxResults', '1');
      listUrl.searchParams.set('fields', 'items(name)');
      const listResponse = await this.fetchImpl(listUrl, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!listResponse.ok) throw new Error(`list-${listResponse.status}`);
      const listing = await listResponse.json() as { items?: Array<{ name?: unknown }> };
      const objectName = listing.items?.[0]?.name;
      if (objectName === undefined) {
        this.sequence = 0;
        this.loaded = true;
        return undefined;
      }
      if (typeof objectName !== 'string') throw new Error('invalid-object-name');
      const sequence = sequenceFromObjectName(objectName, `${this.objectPrefix}/`);
      const objectUrl = `${STORAGE_API}/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
      const objectResponse = await this.fetchImpl(objectUrl, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!objectResponse.ok) throw new Error(`read-${objectResponse.status}`);
      const encodedEnvelope = Buffer.from(await objectResponse.arrayBuffer()).toString('utf8');
      const envelope = parseEnvelope(encodedEnvelope, sequence, this.kmsKey);
      const aad = associatedData(this.bucket, objectName, sequence);
      const wrappedDataKey = decodeBase64(envelope.wrappedDataKey);
      const kmsResponse = await this.kmsRequest(token, `${this.kmsKey}:decrypt`, {
        ciphertext: wrappedDataKey.toString('base64'),
        additionalAuthenticatedData: aad.toString('base64'),
      });
      const dataKey = decodeBase64(kmsResponse.plaintext);
      if (dataKey.length !== 32) {
        dataKey.fill(0);
        throw new Error('invalid-data-key');
      }
      const iv = decodeBase64Url(envelope.iv, 12);
      const tag = decodeBase64Url(envelope.tag, 16);
      const ciphertext = decodeBase64Url(envelope.ciphertext);
      let snapshot: unknown;
      try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const plaintext = gunzipSync(compressed);
        try { snapshot = JSON.parse(plaintext.toString('utf8')) as unknown; }
        finally { plaintext.fill(0); compressed.fill(0); }
      } finally {
        dataKey.fill(0);
      }
      if (!isIssuerStateSnapshot(snapshot)) throw new Error('invalid-state-snapshot');
      this.sequence = sequence;
      this.loaded = true;
      return snapshot;
    } catch {
      this.loaded = false;
      throw new Error('could not load and authenticate issuer state from Cloud Storage');
    }
  }

  async append(snapshot: IssuerStateSnapshot): Promise<void> {
    if (!this.loaded) throw new Error('issuer state store must be loaded before append');
    if (!isIssuerStateSnapshot(snapshot)) throw new Error('issuer state snapshot is invalid');
    const sequence = this.sequence + 1;
    if (!Number.isSafeInteger(sequence) || BigInt(sequence) > MAX_SEQUENCE) {
      this.loaded = false;
      throw new Error('issuer state snapshot sequence is exhausted');
    }
    const objectName = objectNameForSequence(`${this.objectPrefix}/`, sequence);
    const aad = associatedData(this.bucket, objectName, sequence);
    const dataKey = randomBytes(32);
    const iv = randomBytes(12);
    const serialized = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const compressed = gzipSync(serialized);
    serialized.fill(0);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    compressed.fill(0);

    try {
      const token = await this.options.getAccessToken();
      const wrapped = await this.kmsRequest(token, `${this.kmsKey}:encrypt`, {
        plaintext: dataKey.toString('base64'),
        additionalAuthenticatedData: aad.toString('base64'),
      });
      dataKey.fill(0);
      const envelope: EncryptedSnapshot = {
        version: 1,
        sequence,
        algorithm: 'AES-256-GCM',
        keyEncryption: 'GCP-KMS',
        kmsKey: this.kmsKey,
        wrappedDataKey: wrapped.ciphertext,
        iv: iv.toString('base64url'),
        tag: tag.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      };
      const url = new URL(`${STORAGE_UPLOAD_API}/b/${encodeURIComponent(this.bucket)}/o`);
      url.searchParams.set('uploadType', 'media');
      url.searchParams.set('name', objectName);
      url.searchParams.set('ifGenerationMatch', '0');
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        this.loaded = false;
        if (response.status === 409 || response.status === 412) {
          throw new Error('issuer state append lost a create-only race; another issuer may have advanced the state');
        }
        throw new Error(`issuer state Cloud Storage write failed (HTTP ${response.status})`);
      }
      // Read the success body as well: a malformed/aborted response is an unknown write outcome.
      const result = await response.json() as { name?: unknown; generation?: unknown };
      if (result.name !== objectName || typeof result.generation !== 'string' || !/^[0-9]+$/.test(result.generation)) {
        this.loaded = false;
        throw new Error('issuer state Cloud Storage write outcome is unknown');
      }
      this.sequence = sequence;
    } catch (error) {
      dataKey.fill(0);
      this.loaded = false;
      if (error instanceof Error && /^issuer state /.test(error.message)) throw error;
      throw new Error('could not append encrypted issuer state to Cloud Storage');
    }
  }

  private async kmsRequest(token: string, operation: string, body: Record<string, string>): Promise<{ ciphertext: string; plaintext: string }> {
    const response = await this.fetchImpl(`${KMS_API}/${operation}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`kms-${response.status}`);
    const result = await response.json() as { ciphertext?: unknown; plaintext?: unknown };
    if (typeof result.ciphertext !== 'string' && typeof result.plaintext !== 'string') throw new Error('invalid-kms-response');
    if (typeof result.ciphertext === 'string') decodeBase64(result.ciphertext);
    if (typeof result.plaintext === 'string') decodeBase64(result.plaintext).fill(0);
    return {
      ciphertext: typeof result.ciphertext === 'string' ? result.ciphertext : '',
      plaintext: typeof result.plaintext === 'string' ? result.plaintext : '',
    };
  }
}

function validateKmsKey(value: string): string {
  if (!/^projects\/[A-Za-z0-9][A-Za-z0-9.-]{0,62}\/locations\/[a-z0-9-]{1,63}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}$/.test(value)) {
    throw new Error('ISSUER_STATE_KMS_KEY must be a Cloud KMS cryptoKey resource name');
  }
  return value;
}

function validateObjectPrefix(value: string): string {
  if (!value || value.startsWith('/') || value.endsWith('/') || value.length > 900 ||
    !/^[A-Za-z0-9!#$&'()+,._=@~-]+(?:\/[A-Za-z0-9!#$&'()+,._=@~-]+)*$/.test(value)) {
    throw new Error('issuer state object prefix is invalid');
  }
  return value;
}

function objectNameForSequence(prefix: string, sequence: number): string {
  const reverse = MAX_SEQUENCE - BigInt(sequence);
  return `${prefix}${String(reverse).padStart(SEQUENCE_WIDTH, '0')}.json`;
}

function sequenceFromObjectName(name: string, prefix: string): number {
  if (!name.startsWith(prefix)) throw new Error('object is outside the configured issuer state prefix');
  const suffix = name.slice(prefix.length);
  if (!/^[0-9]{16}\.json$/.test(suffix)) throw new Error('object has an invalid issuer state sequence name');
  const reverse = BigInt(suffix.slice(0, -5));
  if (reverse > MAX_SEQUENCE) throw new Error('object has an invalid issuer state sequence');
  const sequence = MAX_SEQUENCE - reverse;
  if (sequence < 1n || sequence > MAX_SEQUENCE) throw new Error('object has an invalid issuer state sequence');
  return Number(sequence);
}

function associatedData(bucket: string, objectName: string, sequence: number): Buffer {
  return Buffer.from(`wraps-issuer-state-v1\n${bucket}\n${objectName}\n${sequence}`, 'utf8');
}

function parseEnvelope(encoded: string, sequence: number, kmsKey: string): EncryptedSnapshot {
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new Error('issuer state envelope is malformed'); }
  if (!value || typeof value !== 'object') throw new Error('issuer state envelope is malformed');
  const envelope = value as Partial<EncryptedSnapshot>;
  if (envelope.version !== 1 || envelope.sequence !== sequence || envelope.algorithm !== 'AES-256-GCM' ||
    envelope.keyEncryption !== 'GCP-KMS' || envelope.kmsKey !== kmsKey ||
    typeof envelope.wrappedDataKey !== 'string' || typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new Error('issuer state envelope does not match the configured state stream');
  }
  return envelope as EncryptedSnapshot;
}

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (!value || bytes.toString('base64') !== value) throw new Error('Cloud KMS returned invalid base64');
  return bytes;
}

function decodeBase64Url(value: string, expectedLength?: number): Buffer {
  const bytes = Buffer.from(value, 'base64url');
  if (!value || bytes.toString('base64url') !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    throw new Error('issuer state envelope contains invalid base64url');
  }
  return bytes;
}
