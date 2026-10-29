import { DurableObject } from "cloudflare:workers";
import { matchesName } from "./names";
import type { VerifiedIdentity } from "./identity/types";

export type DocType = "lab-result" | "rehab-report";

export interface NewRequest {
  id: string;
  /** Matrix ID of the requesting doctor. */
  requester: string;
  requesterName?: string;
  /** Matrix room the request came from. Answers are reported there. */
  roomId?: string;
  patient: { id: string; name: string; birthDate: string };
  docType: DocType;
  recipient: { name: string; channel: "email" | "sms"; address: string };
  tokenHash: string;
  expiresAt: string;
}

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
}

interface Session {
  hash: string;
  identity: VerifiedIdentity;
  verifiedAt: string;
}

interface Record extends NewRequest {
  createdAt: string;
  failedAttempts: number;
  locked: boolean;
  /** "open" until an answer is accepted; "filing" while one is being filed; "filed" afterwards. */
  answer: "open" | "filing" | "filed";
  mismatches: number;
  pending?: Pending;
  session?: Session;
}

export type LinkStatus = "ok" | "unknown" | "expired" | "locked";
export type AuthResult =
  | { outcome: "pass"; sessionId: string; identity: VerifiedIdentity }
  | { outcome: "fail"; reason: "name_mismatch" | "locked"; identity: VerifiedIdentity; locked: boolean };

const MAX_FAILED_ATTEMPTS = 5;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two SHA-256 hex digests. */
async function digestEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/**
 * One instance per request. Durable Objects run one call at a time, so the
 * attempt counter and the single-use auth state need no further locking.
 */
export class RequestDO extends DurableObject<Env> {
  private async load(): Promise<Record | undefined> {
    return this.ctx.storage.get<Record>("r");
  }

  async init(req: NewRequest): Promise<void> {
    if (await this.load()) throw new Error("request exists");
    await this.ctx.storage.put<Record>("r", {
      ...req,
      createdAt: new Date().toISOString(),
      failedAttempts: 0,
      locked: false,
      answer: "open",
      mismatches: 0,
    });
  }

  async checkLink(token: string): Promise<LinkStatus> {
    const r = await this.load();
    if (!r) return "unknown";
    if (!(await digestEquals(await sha256Hex(token), r.tokenHash))) return "unknown";
    if (r.locked) return "locked";
    if (Date.parse(r.expiresAt) < Date.now()) return "expired";
    return "ok";
  }

  /** Store a one-time auth state if the link token is valid. */
  async startAuth(token: string, pending: Pending): Promise<LinkStatus> {
    const status = await this.checkLink(token);
    if (status !== "ok") return status;
    const r = (await this.load())!;
    r.pending = pending;
    await this.ctx.storage.put("r", r);
    return "ok";
  }

  /** Returns the stored nonce and verifier once. A second call with the same state gets null. */
  async takePending(state: string): Promise<Pending | null> {
    const r = await this.load();
    if (!r?.pending || r.pending.state !== state) return null;
    const pending = r.pending;
    delete r.pending;
    await this.ctx.storage.put("r", r);
    return pending;
  }

  /** Compare the eID identity with the person the doctor named. */
  async finishAuth(identity: VerifiedIdentity): Promise<AuthResult> {
    const r = await this.load();
    if (!r || r.locked) return { outcome: "fail", reason: "locked", identity, locked: true };

    if (!matchesName(r.recipient.name, identity.givenName, identity.familyName)) {
      r.failedAttempts += 1;
      r.locked = r.failedAttempts >= MAX_FAILED_ATTEMPTS;
      await this.ctx.storage.put("r", r);
      return { outcome: "fail", reason: "name_mismatch", identity, locked: r.locked };
    }

    const sessionId = crypto.randomUUID();
    r.session = { hash: await sha256Hex(sessionId), identity, verifiedAt: new Date().toISOString() };
    await this.ctx.storage.put("r", r);
    return { outcome: "pass", sessionId, identity };
  }

  /** Only a verified session gets to see anything about the request. */
  async getVerified(sessionId: string): Promise<{
    recipientName: string;
    identity: VerifiedIdentity;
    docType: DocType;
  } | null> {
    const r = await this.load();
    if (!r?.session) return null;
    if (!(await digestEquals(await sha256Hex(sessionId), r.session.hash))) return null;
    return { recipientName: r.recipient.name, identity: r.session.identity, docType: r.docType };
  }

  /** Everything the answer step needs. Only for a verified session. */
  async getAnswerContext(sessionId: string): Promise<AnswerContext | null> {
    const r = await this.load();
    if (!r?.session) return null;
    if (!(await digestEquals(await sha256Hex(sessionId), r.session.hash))) return null;
    return {
      id: r.id,
      requester: r.requester,
      requesterName: r.requesterName,
      roomId: r.roomId,
      createdAt: r.createdAt,
      patient: r.patient,
      docType: r.docType,
      recipient: r.recipient,
      identity: r.session.identity,
      verifiedAt: r.session.verifiedAt,
      answer: r.answer,
    };
  }

  /** Take the single filing slot. A second answer while one is filing or filed is refused. */
  async claimAnswer(sessionId: string): Promise<boolean> {
    const r = await this.load();
    if (!r?.session || r.answer !== "open") return false;
    if (!(await digestEquals(await sha256Hex(sessionId), r.session.hash))) return false;
    r.answer = "filing";
    await this.ctx.storage.put("r", r);
    return true;
  }

  async finishAnswer(filed: boolean): Promise<void> {
    const r = await this.load();
    if (!r) return;
    r.answer = filed ? "filed" : "open";
    await this.ctx.storage.put("r", r);
  }

  async recordMismatch(): Promise<number> {
    const r = await this.load();
    if (!r) return 0;
    r.mismatches += 1;
    await this.ctx.storage.put("r", r);
    return r.mismatches;
  }
}

export interface AnswerContext {
  id: string;
  requester: string;
  requesterName?: string;
  roomId?: string;
  createdAt: string;
  patient: NewRequest["patient"];
  docType: DocType;
  recipient: NewRequest["recipient"];
  identity: VerifiedIdentity;
  verifiedAt: string;
  answer: "open" | "filing" | "filed";
}
