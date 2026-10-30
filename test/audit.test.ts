import { describe, expect, it } from "vitest";
import { audit, verifyAuditChain } from "../src/audit";

type Row = { seq: number; ts: string; request_id: string; event: string; actor: string; detail: string; prev_hash: string; hash: string };

/** Just enough of D1 for the audit log: it stores rows in memory and answers the three statements audit.ts uses. */
function fakeDb(rows: Row[]): D1Database {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...a: unknown[]) {
          args = a;
          return statement;
        },
        async first() {
          const last = [...rows].sort((a, b) => b.seq - a.seq)[0];
          return last ? { seq: last.seq, hash: last.hash } : null;
        },
        async run() {
          const [seq, ts, request_id, event, actor, detail, prev_hash, hash] = args as [number, string, string, string, string, string, string, string];
          if (rows.some((r) => r.seq === seq)) throw new Error("UNIQUE constraint failed: audit.seq");
          rows.push({ seq, ts, request_id, event, actor, detail, prev_hash, hash });
          return {};
        },
        async all() {
          const list = sql.includes("WHERE request_id") ? rows.filter((r) => r.request_id === args[0]) : rows;
          return { results: [...list].sort((a, b) => a.seq - b.seq) };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

async function chainOfThree() {
  const rows: Row[] = [];
  const db = fakeDb(rows);
  await audit(db, { requestId: "r1", event: "request_sent", actor: "@lena.hofer:klinikum.example", detail: { channel: "email" } });
  await audit(db, { requestId: "r1", event: "link_opened", actor: "unauthenticated" });
  await audit(db, { requestId: "r1", event: "identity_checked", actor: "Eva Brandl", detail: { outcome: "pass" } });
  return { rows, db };
}

describe("audit hash chain", () => {
  it("verifies an untouched chain", async () => {
    const { db } = await chainOfThree();
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: 3 });
  });
  it("detects an edited entry at that entry", async () => {
    const { rows, db } = await chainOfThree();
    rows[1]!.actor = "somebody else";
    expect(await verifyAuditChain(db)).toEqual({ ok: false, count: 3, brokenAt: 2 });
  });
  it("detects a deleted entry at the one after it", async () => {
    const { rows, db } = await chainOfThree();
    rows.splice(1, 1);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, brokenAt: 3 });
  });
  it("detects a rewritten detail field", async () => {
    const { rows, db } = await chainOfThree();
    rows[2]!.detail = JSON.stringify({ outcome: "fail" });
    expect((await verifyAuditChain(db)).ok).toBe(false);
  });
  it("does not detect removal of the newest entries (known limit: the head hash is not anchored outside the database)", async () => {
    const { rows, db } = await chainOfThree();
    rows.pop();
    expect(await verifyAuditChain(db)).toEqual({ ok: true, count: 2 });
  });
});
