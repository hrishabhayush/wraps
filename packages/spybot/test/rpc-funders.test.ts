import { describe, expect, it } from "vitest";
import { XrplRpc, PUBLIC_NODES, TESTNET_NODES } from "../src/rpc.js";
import { clusterByFunder, estimateSentTxs } from "../src/funders.js";
import { formatCluster } from "../src/format.js";

function jsonResponse(result: unknown, status = 200) {
  return new Response(JSON.stringify({ result }), { status, headers: { "content-type": "application/json" } });
}

describe("XrplRpc", () => {
  it("rotates endpoints and retries on tooBusy and HTTP 503", async () => {
    const seen: string[] = [];
    let n = 0;
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      n++;
      if (n === 1) return jsonResponse({ status: "error", error: "tooBusy" });
      if (n === 2) return new Response("busy", { status: 503 });
      return jsonResponse({ status: "success", ok: true });
    }) as unknown as typeof fetch;
    const rpc = new XrplRpc({ endpoints: ["a", "b", "c"], fetchImpl, baseDelayMs: 1 });
    const res = await rpc.request("server_info");
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("does not retry non-retryable errors", async () => {
    const fetchImpl = (async () => jsonResponse({ status: "error", error: "actNotFound" })) as unknown as typeof fetch;
    const rpc = new XrplRpc({ endpoints: ["a"], fetchImpl, baseDelayMs: 1 });
    await expect(rpc.request("account_info")).rejects.toMatchObject({ code: "actNotFound" });
  });

  it("puts Quicknode first and keeps public nodes as fallback", () => {
    const rpc = XrplRpc.withQuicknode("https://qn.example/");
    expect(rpc.endpoints[0]).toBe("https://qn.example/");
    expect(rpc.endpoints.length).toBe(4);
  });

  it("keeps testnet RPC isolated from mainnet nodes", () => {
    const rpc = XrplRpc.testnet();
    expect(rpc.endpoints).toEqual(TESTNET_NODES);
    expect(rpc.endpoints).not.toEqual(expect.arrayContaining(PUBLIC_NODES));
  });
});

describe("estimateSentTxs", () => {
  it("handles new accounts (sequence starts at creation ledger) and old ones", () => {
    expect(estimateSentTxs(106640903, 106640000)).toBe(903);
    expect(estimateSentTxs(500, 40_000_000)).toBe(500);
  });
});

describe("clusterByFunder", () => {
  // Payers P1..P3 funded by F1, P4 by F2. F1 funded by EX (a huge wallet). F2 is itself huge.
  const funding: Record<string, { from: string; ledger: number }> = {
    P1: { from: "F1", ledger: 100_000_100 },
    P2: { from: "F1", ledger: 100_000_200 },
    P3: { from: "F1", ledger: 100_000_300 },
    P4: { from: "F2", ledger: 100_000_400 },
    F1: { from: "EX", ledger: 90_000_000 },
    F2: { from: "ZZ", ledger: 1_000 },
    EX: { from: "GENESIS", ledger: 5_000 },
  };
  const info: Record<string, { Balance: string; Sequence: number }> = {
    F1: { Balance: String(5_000 * 1e6), Sequence: 90_000_500 },
    F2: { Balance: String(2_000_000 * 1e6), Sequence: 10 },
    EX: { Balance: String(150_000_000 * 1e6), Sequence: 72_000_000 },
  };
  const calls: string[] = [];
  const fake = {
    async request(method: string, params: any) {
      calls.push(`${method}:${params.account}`);
      if (method === "account_tx") {
        const f = funding[params.account];
        if (!f) return { transactions: [] };
        return {
          transactions: [
            { tx: { TransactionType: "Payment", Account: f.from, Destination: params.account, ledger_index: f.ledger, hash: "H" }, meta: {} },
          ],
        };
      }
      if (method === "account_info") return { account_data: info[params.account] };
      throw new Error(method);
    },
  } as unknown as XrplRpc;

  it("groups payers by first funder and labels likely exchanges", async () => {
    const r = await clusterByFunder(fake, ["P1", "P2", "P3", "P4", "P1", "PX"], { upstream: true });
    expect(r.payersTraced).toBe(4);
    expect(r.payersUntraced).toEqual(["PX"]);
    expect(r.clusters.map((c) => [c.funder, c.payers.length, c.likelyExchange])).toEqual([
      ["F1", 3, false],
      ["F2", 1, true],
    ]);
    expect(r.clusters[0].fundedBy).toMatchObject({ address: "EX", likelyExchange: true });
    // Stop rule: F2 is a likely exchange, so we never look above it.
    expect(r.clusters[1].fundedBy).toBeUndefined();
    expect(calls).not.toContain("account_tx:ZZ");
    expect(formatCluster(r)[0]).toBe("4 wallets → 2 funders");
  });
});
