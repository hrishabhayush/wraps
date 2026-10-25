// Read-only account discovery using the sign-in flow in the supplied AP4M starter.
export async function ap4mSession(
  wallet: { getAddress(): Promise<string>; signMessage(message: string): Promise<string> },
  teamName: string,
  request: typeof fetch = fetch,
) {
  const api = 'https://hackathon.ap4m.build';
  const address = await wallet.getAddress();
  async function call(path: string, init?: RequestInit) {
    const response = await request(api + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
    // Do not print arbitrary service errors: they can echo authentication material.
    if (!response.ok) throw new Error(`AP4M ${path} returned HTTP ${response.status}. Check the team name and registered agent address.`);
    return response.json();
  }
  const challenge = await call('/public/participant/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamName, wallet: address }),
  });
  if (typeof challenge.message !== 'string' || !challenge.message || challenge.message.length > 10000 || typeof challenge.challengeId !== 'string') {
    throw new Error('AP4M returned an invalid sign-in challenge');
  }
  const signature = await wallet.signMessage(challenge.message);
  const session = await call('/public/participant/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  if (typeof session.token !== 'string' || !session.token) throw new Error('AP4M returned no session token');
  return { address, call: (path: string, init?: RequestInit) => call(path, {
    ...init, headers: { ...init?.headers, Authorization: `Bearer ${session.token}` },
  }) };
}

export async function checkAp4mAccount(
  wallet: { getAddress(): Promise<string>; signMessage(message: string): Promise<string> },
  teamName: string,
  request: typeof fetch = fetch,
) {
  const session = await ap4mSession(wallet, teamName, request);
  const data = await session.call('/public/participant/channels');
  if (!Array.isArray(data.channels)) throw new Error('AP4M returned an invalid channel list');
  return {
    team: teamName, agent: session.address,
    channels: data.channels.map((c: Record<string, unknown>) => ({
      channelId: c.channel_id, status: c.channel_status, capWei: c.cap_wei,
      merchantId: c.merchant_id, payout: c.payout,
    })),
  };
}
