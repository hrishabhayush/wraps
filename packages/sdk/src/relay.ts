import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type ConnectionOptions, type PeerCertificate, type TLSSocket } from 'node:tls';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { AttestationError, hashPublicKeys, fromB64u, type AttestationVerifier, type VerifiedAttestation } from '@wraps/attestation';
import type { PeerResponse } from '@wraps/issuer';
import { encodeAuthorization, type Token } from '@wraps/tokens';

const DEFAULT_ATTESTATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTESTATION_BYTES = 64 * 1024;
const ISSUER_RESPONSE_TIMEOUT_MS = 15_000;
const MAX_ISSUER_RESPONSE_BYTES = 1024 * 1024;
const pinnedFetch = undiciFetch as unknown as (input: URL, init: RequestInit) => Promise<Response>;

export interface RelayAttestationResponse {
  format: string;
  publicKeys: { tunnel: string };
  /** Self-signed relay TLS certificate whose SPKI is the attested tunnel key. */
  tlsCertificate: string;
  attestation: string;
}

export interface AttestedRelay {
  url: string;
  tunnelKey: Uint8Array;
  tlsCertificate: string;
  attestation: VerifiedAttestation;
}

export interface PinnedRelayTransport {
  readonly relay: AttestedRelay;
  readonly issuerOrigin: string;
  /** Opens a fresh CONNECT tunnel and puts these tokens only in its proxy authorization header. */
  fetchWithTokens(input: string, init: RequestInit | undefined, proxyTokens: Token[]): Promise<Response>;
  /** First issuer request: no proxy meter auth, but records the target TLS peer SPKI. */
  fetchIssuerWithPeer(input: string, init?: RequestInit): Promise<PeerResponse>;
  /** Later issuer requests: no proxy meter auth and target TLS pinned to the attested SPKI. */
  fetchIssuer(input: string, init: RequestInit | undefined, expectedSpki?: Uint8Array): Promise<Response>;
  close(): Promise<void>;
}

export interface RelayTransportOptions {
  /** HTTPS URL of the relay's CONNECT proxy. */
  relayUrl: string;
  /** Exact HTTPS origin permitted for tokenless issuer CONNECTs. */
  issuerUrl: string;
  verifier: AttestationVerifier;
  /** Optional untrusted URL used only to fetch a fresh, nonce-bound receipt. */
  attestationUrl?: string;
  fetchImpl?: typeof fetch;
  /** Bootstrap request deadline. Defaults to 10 seconds. */
  attestationTimeoutMs?: number;
  /** Maximum bootstrap JSON size. Defaults to 64 KiB. */
  maxAttestationResponseBytes?: number;
}

/** Fetch and verify a fresh relay receipt before creating any tunneled requests. */
export async function createPinnedRelayTransport(opts: RelayTransportOptions): Promise<PinnedRelayTransport> {
  const relayUrl = new URL(opts.relayUrl);
  if (relayUrl.protocol !== 'https:' || relayUrl.username || relayUrl.password || relayUrl.hash) {
    throw new TypeError('relayUrl must be an HTTPS URL without credentials or a fragment');
  }
  relayUrl.pathname = '/';
  relayUrl.search = '';
  const relayIsIp = isIP(relayUrl.hostname.replace(/^\[|\]$/g, '')) !== 0;
  const issuerUrl = new URL(opts.issuerUrl);
  if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.hash || issuerUrl.port) {
    throw new TypeError('issuerUrl must be an HTTPS URL on port 443 without credentials or a fragment');
  }
  const issuerOrigin = issuerUrl.origin;

  const attestationUrl = opts.attestationUrl ? new URL(opts.attestationUrl) : new URL(relayUrl);
  if (!opts.attestationUrl) {
    attestationUrl.protocol = 'http:';
    attestationUrl.port = '8080';
  }
  // The RLY-03 receipt listener is plain HTTP (default port 8080), separate from the HTTPS CONNECT
  // listener. The receipt is untrusted transport data: it is accepted only after the verifier checks
  // the fresh nonce and the tunnel key hash, and the tunnel is then pinned to that key.
  if ((attestationUrl.protocol !== 'http:' && attestationUrl.protocol !== 'https:') || attestationUrl.username || attestationUrl.password) {
    throw new TypeError('attestationUrl must be an HTTP or HTTPS URL without credentials');
  }
  attestationUrl.pathname = '/attestation';
  attestationUrl.search = '';
  attestationUrl.hash = '';

  const timeoutMs = opts.attestationTimeoutMs ?? DEFAULT_ATTESTATION_TIMEOUT_MS;
  const maxResponseBytes = opts.maxAttestationResponseBytes ?? DEFAULT_MAX_ATTESTATION_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('attestationTimeoutMs must be a positive integer');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new TypeError('maxAttestationResponseBytes must be a positive integer');

  const attested = await fetchAttestedRelay(
    relayUrl,
    attestationUrl,
    opts.verifier,
    opts.fetchImpl ?? fetch,
    timeoutMs,
    maxResponseBytes,
  );
  const agents = new Set<ProxyAgent>();
  let closed = false;

  const request = async (
    input: string,
    init: RequestInit | undefined,
    proxyTokens: Token[] | undefined,
    requestTls?: ProxyAgent.Options['requestTls'],
  ): Promise<Response> => {
    if (closed) throw new TypeError('pinned relay transport is closed');
    const target = new URL(input);
    if (target.protocol !== 'https:') throw new TypeError('relay transport only allows HTTPS destinations');
    if (proxyTokens && proxyTokens.length === 0) throw new TypeError('a blind-token batch is required for every metered relay tunnel');

    const headers = new Headers(init?.headers);
    // Proxy credentials belong to CONNECT only; callers cannot inject them into
    // the tunneled origin request.
    headers.delete('proxy-authorization');
    const agent = new ProxyAgent({
      uri: relayUrl.origin,
      ...(proxyTokens ? { token: encodeAuthorization(proxyTokens) } : {}),
      proxyTls: {
        ca: attested.tlsCertificate,
        // Undici fills an omitted SNI name from the proxy URI, which fails for
        // IP literals in Node. Use a non-routable DNS name; the attested SPKI
        // check, not the SNI hostname, authenticates the relay certificate.
        servername: relayIsIp ? 'wraps-relay.invalid' : relayUrl.hostname,
        // The relay endpoint may be an IP while its attested cert has no IP
        // SAN. The receipt's SPKI pin authenticates that cert directly.
        checkServerIdentity: (hostname, peer) => checkPinnedIdentity(hostname, peer, attested.tunnelKey, !relayIsIp),
      },
      ...(requestTls ? { requestTls } : {}),
    });
    agents.add(agent);
    const cleanup = async () => {
      if (!agents.delete(agent)) return;
      await agent.close();
    };

    let response: Response;
    try {
      // A fresh dispatcher binds this token batch to one CONNECT. Applying it
      // after RequestInit prevents callers from replacing the pinned dispatcher.
      response = await pinnedFetch(target, { ...init, headers, dispatcher: agent } as RequestInit & { dispatcher: ProxyAgent });
    } catch (error) {
      await cleanup().catch(() => {});
      throw error;
    }
    return responseWithCleanup(response, cleanup);
  };

  const checkIssuerOrigin = (input: string): URL => {
    const target = new URL(input);
    if (target.protocol !== 'https:' || target.origin !== issuerOrigin || target.username || target.password || target.hash) {
      throw new TypeError(`issuer requests are restricted to ${issuerOrigin}`);
    }
    return target;
  };

  const fetchIssuerWithPeer = async (input: string, init?: RequestInit): Promise<PeerResponse> => {
    const target = checkIssuerOrigin(input);
    return requestIssuerThroughRelay(relayUrl, attested.tlsCertificate, attested.tunnelKey, target, init);
  };

  const fetchIssuer = (input: string, init: RequestInit | undefined, expectedSpki?: Uint8Array): Promise<Response> => {
    const target = checkIssuerOrigin(input);
    if (!expectedSpki) throw new TypeError('issuer requests require the attested TLS SPKI');
    return requestIssuerThroughRelay(relayUrl, attested.tlsCertificate, attested.tunnelKey, target, init, expectedSpki).then(({ response }) => response);
  };

  const transport: PinnedRelayTransport = {
    relay: attested,
    issuerOrigin,
    fetchWithTokens: (input, init, tokens) => request(input, init, tokens),
    fetchIssuerWithPeer,
    fetchIssuer,
    close: async () => {
      closed = true;
      await Promise.all([...agents].map(async (agent) => {
        agents.delete(agent);
        await agent.close();
      }));
    },
  };
  return transport;
}

async function requestIssuerThroughRelay(
  relayUrl: URL,
  relayCertificate: string,
  relaySpki: Uint8Array,
  target: URL,
  init?: RequestInit,
  expectedIssuerSpki?: Uint8Array,
): Promise<PeerResponse> {
  let tunnel: TLSSocket | undefined;
  try {
    const relaySocket = await tlsHandshake({
      host: relayUrl.hostname,
      port: Number(relayUrl.port || 443),
      servername: isIP(relayUrl.hostname.replace(/^\[|\]$/g, '')) ? undefined : relayUrl.hostname,
      ca: relayCertificate,
      ALPNProtocols: ['http/1.1'],
      checkServerIdentity: (hostname, peer) => checkPinnedIdentity(hostname, peer, relaySpki),
    });
    await openIssuerConnect(relaySocket, target);

    const targetHost = target.hostname.replace(/^\[|\]$/g, '');
    tunnel = await tlsHandshake({
      socket: relaySocket,
      servername: isIP(targetHost) ? undefined : targetHost,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const peer = tunnel.getPeerX509Certificate();
    if (!peer) throw new AttestationError('KEY_MISMATCH', 'issuer did not present a TLS certificate');
    const peerSpki = new Uint8Array(peer.publicKey.export({ type: 'spki', format: 'der' }));
    if (expectedIssuerSpki && !sameBytes(peerSpki, expectedIssuerSpki)) {
      throw new AttestationError('KEY_MISMATCH', 'issuer TLS key does not match the attested key');
    }
    const response = await sendIssuerRequest(tunnel, target, init);
    return { response, peerSpki };
  } catch (error) {
    tunnel?.destroy();
    throw error;
  }
}

function tlsHandshake(options: ConnectionOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(options);
    const timer = setTimeout(() => fail(new Error('issuer TLS handshake timed out')), ISSUER_RESPONSE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('secureConnect', onSecure);
      socket.off('error', onError);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onSecure = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => fail(error);
    socket.once('secureConnect', onSecure);
    socket.once('error', onError);
  });
}

async function openIssuerConnect(proxySocket: TLSSocket, target: URL): Promise<void> {
  const authority = target.port ? target.host : `${target.host}:443`;
  const request = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\n\r\n`;
  await new Promise<void>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('issuer CONNECT timed out')), ISSUER_RESPONSE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      proxySocket.off('data', onData);
      proxySocket.off('error', onError);
    };
    const fail = (error: Error) => {
      cleanup();
      proxySocket.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16 * 1024) {
        fail(new Error('issuer CONNECT response headers are too large'));
        return;
      }
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = buffer.subarray(0, end).toString('latin1');
      const status = /^HTTP\/1\.[01] (\d{3})\b/.exec(header)?.[1];
      if (status !== '200') {
        fail(new Error(`relay refused issuer CONNECT with HTTP ${status ?? 'invalid'}`));
        return;
      }
      cleanup();
      const extra = buffer.subarray(end + 4);
      proxySocket.pause();
      if (extra.length > 0) proxySocket.unshift(extra);
      proxySocket.resume();
      resolve();
    };
    const onError = (error: Error) => fail(error);
    proxySocket.on('data', onData);
    proxySocket.once('error', onError);
    proxySocket.write(request);
  });
}

async function sendIssuerRequest(socket: TLSSocket, target: URL, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    if (name.toLowerCase() !== 'proxy-authorization') headers[name] = value;
  });
  headers.connection = 'close';
  const body = toRequestBuffer(init?.body);
  if (body) headers['content-length'] = String(body.byteLength);

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseSize = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(new Error('issuer HTTP response timed out')), ISSUER_RESPONSE_TIMEOUT_MS);
    const signal = init?.signal;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy(error);
      reject(error);
    };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('issuer request aborted'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const request = httpRequest({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      createConnection: () => socket,
    }, (res) => {
      res.on('data', (chunk: Buffer) => {
        responseSize += chunk.length;
        if (responseSize > MAX_ISSUER_RESPONSE_BYTES) {
          fail(new Error(`issuer response exceeds ${MAX_ISSUER_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = res.statusCode ?? 0;
        const noBody = status === 204 || status === 304;
        const response = new Response(noBody ? null : Buffer.concat(chunks), {
          status,
          statusText: res.statusMessage,
          headers: responseHeaders,
        });
        socket.destroy();
        resolve(response);
      });
      res.on('aborted', () => fail(new Error('issuer response was aborted')));
      res.on('error', fail);
    });
    request.on('error', fail);
    request.end(body);
  });
}

function toRequestBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('issuer relay requests support string or byte bodies only');
}

async function fetchAttestedRelay(
  relayUrl: URL,
  attestationUrl: URL,
  verifier: AttestationVerifier,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<AttestedRelay> {
  const nonce = randomBytes(32);
  const requestUrl = new URL(attestationUrl);
  requestUrl.searchParams.set('nonce', nonce.toString('hex'));

  // One absolute deadline covers the request, the headers and the body. It does not rely on
  // fetchImpl honouring the abort signal: a stalled server or fetch cannot hold bootstrap open.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`relay attestation timed out after ${timeoutMs} ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  let body: RelayAttestationResponse;
  try {
    body = await Promise.race([readAttestation(requestUrl, fetchImpl, controller.signal, maxResponseBytes), deadline]);
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    throw new AttestationError('MALFORMED', `relay attestation request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!body?.format || body.format !== verifier.format || !body.attestation || !body.tlsCertificate || !body.publicKeys?.tunnel) {
    throw new AttestationError('MALFORMED', 'relay attestation response is missing required fields or has the wrong format');
  }

  const tunnelKey = fromB64u(body.publicKeys.tunnel);
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(body.tlsCertificate);
  } catch {
    throw new AttestationError('MALFORMED', 'relay TLS certificate is invalid');
  }
  if (!sameBytes(certificate.publicKey.export({ type: 'spki', format: 'der' }) as Uint8Array, tunnelKey)) {
    throw new AttestationError('KEY_MISMATCH', 'relay TLS certificate key does not match its attested tunnel key');
  }

  const attestation = await verifier.verify(body.attestation, {
    nonce,
    publicKeysHash: hashPublicKeys({ tunnel: tunnelKey }),
  });
  return {
    url: relayUrl.origin,
    tunnelKey,
    tlsCertificate: body.tlsCertificate,
    attestation,
  };
}

async function readAttestation(
  requestUrl: URL,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<RelayAttestationResponse> {
  const res = await fetchImpl(requestUrl, { signal, redirect: 'error' });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new AttestationError('MALFORMED', `relay returned HTTP ${res.status}`);
  }
  const bytes = await readLimitedBody(res, maxResponseBytes, signal);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as RelayAttestationResponse;
  } catch {
    throw new AttestationError('MALFORMED', 'relay returned invalid attestation JSON');
  }
}

async function readLimitedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`relay attestation response exceeds ${limit} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  // Release a stalled read when the deadline fires.
  const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(`relay attestation response exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseWithCleanup(response: Response, cleanup: () => Promise<void>): Response {
  if (!response.body) {
    void cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let cleaned = false;
  const finish = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanup();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await finish();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await finish().catch(() => {});
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await finish();
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function checkPinnedIdentity(hostname: string, peer: PeerCertificate, expectedKey: Uint8Array, checkHostname = true): Error | undefined {
  if (checkHostname) {
    const hostnameError = checkServerIdentity(hostname, peer);
    if (hostnameError) return hostnameError;
  }
  if (!peer.raw) return new Error('relay did not provide a TLS certificate');
  try {
    const cert = new X509Certificate(peer.raw);
    const actualKey = cert.publicKey.export({ type: 'spki', format: 'der' }) as Uint8Array;
    if (!sameBytes(actualKey, expectedKey)) return new Error('relay TLS key does not match the verified attestation');
  } catch {
    return new Error('relay TLS certificate could not be parsed');
  }
  return undefined;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
