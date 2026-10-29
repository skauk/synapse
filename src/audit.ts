export type AuditEvent =
  | "request_sent"
  | "link_opened"
  | "identity_checked"
  | "answer_sent"
  | "answer_filed"
  | "misdelivery_caught";

export interface AuditEntry {
  requestId: string;
  event: AuditEvent;
  /** Who did it: a Matrix ID, a verified or claimed person, or "service". */
  actor: string;
  detail?: Record<string, unknown>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const GENESIS = "0".repeat(64);

function hashEntry(r: { seq: number; ts: string; request_id: string; event: string; actor: string; detail: string }, prev: string) {
  return sha256Hex([r.seq, r.ts, r.request_id, r.event, r.actor, r.detail, prev].join("|"));
}

export interface AuditRow {
  seq: number;
  ts: string;
  request_id: string;
  event: AuditEvent;
  actor: string;
  detail: string;
  prev_hash: string;
  hash: string;
}

export async function auditFor(db: D1Database, requestId: string): Promise<AuditRow[]> {
  const { results } = await db.prepare("SELECT * FROM audit WHERE request_id = ? ORDER BY seq").bind(requestId).all<AuditRow>();
  return results;
}

/** Recompute the whole chain. Any edited, removed or reordered entry shows up as the first broken seq. */
export async function verifyAuditChain(db: D1Database): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
  const { results } = await db.prepare("SELECT * FROM audit ORDER BY seq").all<AuditRow>();
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const row of results) {
    if (row.seq !== expectedSeq || row.prev_hash !== prev || row.hash !== (await hashEntry(row, prev))) {
      return { ok: false, count: results.length, brokenAt: row.seq };
    }
    prev = row.hash;
    expectedSeq++;
  }
  return { ok: true, count: results.length };
}

/** Append to the hash chain. Retries when a concurrent writer took the same seq. */
export async function audit(db: D1Database, entry: AuditEntry): Promise<void> {
  const detail = JSON.stringify(entry.detail ?? {});
  const ts = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const tail = await db
      .prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1")
      .first<{ seq: number; hash: string }>();
    const seq = (tail?.seq ?? 0) + 1;
    const prev = tail?.hash ?? GENESIS;
    const hash = await hashEntry({ seq, ts, request_id: entry.requestId, event: entry.event, actor: entry.actor, detail }, prev);
    try {
      await db
        .prepare(
          "INSERT INTO audit (seq, ts, request_id, event, actor, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(seq, ts, entry.requestId, entry.event, entry.actor, detail, prev, hash)
        .run();
      return;
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
}
