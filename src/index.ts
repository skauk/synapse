import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { audit, auditFor, verifyAuditChain } from "./audit";
import { createRequest } from "./create-request";
import { processEvents, type MatrixEvent } from "./matrix";
import { randomToken, requestStub as stubFor, secretEquals, sha256Hex } from "./util";
import { buildBundle } from "./fhir";
import { fileBundle } from "./fhir-client";
import { matchesName, sameName } from "./names";
import { notifyRequester } from "./notify";
import { ParseError, parseAnswer, type ParsedDoc } from "./parse";
import { esc, page } from "./html";
import { loaRank } from "./identity/loa";
import { MOCK_PEOPLE, MockProvider } from "./identity/mock";
import { OidcProvider } from "./identity/oidc";
import type { IdentityProvider } from "./identity/types";
import { RequestDO, type AnswerContext, type DocType, type NewRequest } from "./request-do";

export { RequestDO };

const DOC_TYPES: DocType[] = ["lab-result", "rehab-report"];
const MAX_ANSWER_BYTES = 256 * 1024;

const app = new Hono<{ Bindings: Env }>();

/** The mock IdP lets anyone log in as anyone, so it only runs against a localhost base URL. */
function mockEnabled(env: Env): boolean {
  return env.IDP === "mock" && /^http:\/\/localhost(:\d+)?$/.test(env.BASE_URL);
}

const list = (csv: string) => csv.split(",").map((n) => n.trim()).filter(Boolean);

function providerFor(env: Env): IdentityProvider {
  if (env.IDP === "mock") {
    if (!mockEnabled(env)) throw new Error("The mock identity provider is only allowed on localhost");
    return new MockProvider(env.BASE_URL);
  }
  return new OidcProvider({
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    scopes: env.OIDC_SCOPES,
    clientAuth: env.OIDC_CLIENT_AUTH === "basic" ? "basic" : "post",
    claims: {
      givenName: list(env.OIDC_CLAIM_GIVEN_NAME),
      familyName: list(env.OIDC_CLAIM_FAMILY_NAME),
      bpk: list(env.OIDC_CLAIM_BPK),
      loa: list(env.OIDC_CLAIM_LOA),
    },
    ...(env.OIDC_CLAIMS_REQUEST ? { claimsRequest: env.OIDC_CLAIMS_REQUEST } : {}),
    method: "id-austria",
  });
}

/** Requests come from the Matrix bot. Shape is checked by hand to keep the Worker dependency-light. */
function parseNewRequest(raw: unknown): Omit<NewRequest, "id" | "tokenHash" | "expiresAt"> | null {
  const o = raw as Record<string, any> | null;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!o || !str(o.requester)) return null;
  if (!str(o.patient?.id) || !str(o.patient?.name) || !/^\d{4}-\d{2}-\d{2}$/.test(o.patient?.birthDate ?? "")) return null;
  if (!DOC_TYPES.includes(o.docType)) return null;
  if (!str(o.recipient?.name) || !str(o.recipient?.address)) return null;
  if (o.recipient.channel !== "email" && o.recipient.channel !== "sms") return null;
  return {
    requester: o.requester,
    ...(str(o.requesterName) ? { requesterName: o.requesterName } : {}),
    ...(str(o.roomId) ? { roomId: o.roomId } : {}),
    patient: { id: o.patient.id, name: o.patient.name, birthDate: o.patient.birthDate },
    docType: o.docType,
    recipient: { name: o.recipient.name, channel: o.recipient.channel, address: o.recipient.address },
  };
}

app.get("/healthz", (c) => c.text("ok"));

// ---- Matrix bot -> service -------------------------------------------------

async function botAuthorized(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
  return bearer !== "" && (await secretEquals(bearer, c.env.BOT_API_TOKEN));
}

// Audit trail for the clinic: one request's entries, and a check of the whole hash chain.
app.get("/api/requests/:id/audit", async (c) => {
  if (!(await botAuthorized(c))) return c.json({ error: "unauthorized" }, 401);
  const rows = await auditFor(c.env.DB, c.req.param("id"));
  return c.json(rows.map((r) => ({ seq: r.seq, ts: r.ts, event: r.event, actor: r.actor, detail: JSON.parse(r.detail) })));
});
app.get("/api/audit/verify", async (c) => ((await botAuthorized(c)) ? c.json(await verifyAuditChain(c.env.DB)) : c.json({ error: "unauthorized" }, 401)));

app.post("/api/requests", async (c) => {
  if (!(await botAuthorized(c))) return c.json({ error: "unauthorized" }, 401);

  const input = parseNewRequest(await c.req.json().catch(() => null));
  if (!input) return c.json({ error: "invalid request" }, 400);

  const { id, link, delivery } = await createRequest(c.env, input);
  return c.json({ id, link, delivery }, 201);
});

// ---- Outside person --------------------------------------------------------

app.get("/r/:id/:token", async (c) => {
  const { id, token } = c.req.param();
  const status = await stubFor(c.env, id).checkLink(token);
  if (status === "unknown") return page("Link not valid", "<h1>This link is not valid.</h1>", 404);

  await audit(c.env.DB, { requestId: id, event: "link_opened", actor: "unauthenticated", detail: { status } });
  if (status !== "ok") {
    return page("Link not available", "<h1>This link can no longer be used.</h1><p>Ask the sender for a new one.</p>", 410);
  }
  // Deliberately generic: no patient, no document type before the identity is proven.
  return page(
    "Secure request",
    `<h1>Secure request</h1>
<p>A colleague at ${esc(c.env.SENDER_ORG)} has sent you a request.
Please identify yourself with your electronic ID to continue.</p>
<form method="post" action="/auth/start">
<input type="hidden" name="rid" value="${esc(id)}"><input type="hidden" name="token" value="${esc(token)}">
<button type="submit">Identify with ID Austria</button></form>`,
  );
});

app.post("/auth/start", async (c) => {
  const form = await c.req.formData();
  const rid = String(form.get("rid") ?? "");
  const token = String(form.get("token") ?? "");
  const pending = { state: `${rid}.${randomToken(16)}`, nonce: randomToken(16), verifier: randomToken(32) };
  const status = await stubFor(c.env, rid).startAuth(token, pending);
  if (status !== "ok") return page("Link not available", "<h1>This link can no longer be used.</h1>", 410);

  const url = await providerFor(c.env).begin({ ...pending, redirectUri: `${c.env.BASE_URL}/auth/callback` });
  return c.redirect(url, 303);
});

app.get("/auth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const rid = state.split(".")[0] ?? "";
  const stub = stubFor(c.env, rid);
  const pending = await stub.takePending(state);
  if (!pending) return page("Session expired", "<h1>This sign-in session has expired.</h1><p>Open the link again.</p>", 400);

  let identity;
  try {
    identity = await providerFor(c.env).complete(c.req.raw, { ...pending, redirectUri: `${c.env.BASE_URL}/auth/callback` });
  } catch (err) {
    await audit(c.env.DB, {
      requestId: rid,
      event: "identity_checked",
      actor: "unauthenticated",
      detail: { outcome: "error", error: err instanceof Error ? err.message : "unknown" },
    });
    return page("Identification failed", "<h1>Identification failed.</h1><p>Please try again from the link.</p>", 401);
  }

  // The eID must reach the required eIDAS level. An unknown level never passes.
  if (loaRank(identity.loa) < loaRank(c.env.MIN_LOA)) {
    await audit(c.env.DB, {
      requestId: rid,
      event: "identity_checked",
      actor: `${identity.givenName} ${identity.familyName}`,
      detail: { outcome: "fail", reason: "assurance_too_low", loa: identity.loa, required: c.env.MIN_LOA, method: identity.method },
    });
    return page("Security level too low", "<h1>Your electronic ID does not reach the required security level.</h1><p>Nothing has been shared with you.</p>", 403);
  }

  const result = await stub.finishAuth(identity);
  const who = `${identity.givenName} ${identity.familyName}`;
  const bpkHash = identity.bpk ? (await sha256Hex(identity.bpk)).slice(0, 16) : undefined;
  await audit(c.env.DB, {
    requestId: rid,
    event: "identity_checked",
    actor: who,
    detail: {
      outcome: result.outcome,
      ...(result.outcome === "fail" ? { reason: result.reason, locked: result.locked } : {}),
      method: identity.method,
      loa: identity.loa,
      bpkHash,
      ...(identity.claimsUsed ? { claimsUsed: identity.claimsUsed } : {}),
    },
  });

  if (result.outcome === "fail") {
    // Same message for every failure: no hint about who was expected.
    return page(
      "Not the intended recipient",
      "<h1>This request is not for you.</h1><p>It was addressed to someone else. Nothing has been shared with you.</p>",
      403,
    );
  }

  setCookie(c, "sid", `${rid}.${result.sessionId}`, {
    httpOnly: true,
    secure: c.env.BASE_URL.startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge: 3600,
  });
  return c.redirect("/answer", 303);
});

const DOC_LABEL: Record<DocType, string> = { "lab-result": "laboratory result", "rehab-report": "rehabilitation discharge report" };

async function verifiedSession(c: Context<{ Bindings: Env }>) {
  const [rid = "", sid = ""] = (getCookie(c, "sid") ?? "").split(".");
  if (!rid || !sid) return null;
  const stub = stubFor(c.env, rid);
  const ctx = await stub.getAnswerContext(sid);
  return ctx ? { rid, sid, stub, ctx } : null;
}

function answerForm(ctx: AnswerContext, error?: string): Response {
  const done = ctx.answer !== "open";
  return page(
    "Answer",
    `<h1>Welcome, ${esc(ctx.identity.givenName)} ${esc(ctx.identity.familyName)}</h1>
<p>Identity confirmed (${esc(ctx.identity.method)}, level ${esc(ctx.identity.loa)}).</p>
${error ? `<p role="alert"><strong>${esc(error)}</strong></p>` : ""}
${
  done
    ? "<p>Your answer has already been received. Thank you.</p>"
    : `<p>${esc(ctx.requesterName ?? ctx.requester)} asks for the <strong>${DOC_LABEL[ctx.docType]}</strong> of
<strong>${esc(ctx.patient.name)}</strong>, born ${esc(ctx.patient.birthDate)}.</p>
<form method="post" action="/answer" enctype="multipart/form-data">
<p><label>Upload the document (Markdown)<br><input type="file" name="file" accept=".md,.markdown,text/markdown,text/plain"></label></p>
<p><label>or paste it here<br><textarea name="text" rows="14" cols="70"></textarea></label></p>
<button type="submit">Send answer</button></form>`
}`,
    error ? 422 : 200,
  );
}

app.get("/answer", async (c) => {
  const s = await verifiedSession(c);
  if (!s) return page("Not signed in", "<h1>Please open your link again.</h1>", 401);
  return answerForm(s.ctx);
});

app.post("/answer", async (c) => {
  const s = await verifiedSession(c);
  if (!s) return page("Not signed in", "<h1>Please open your link again.</h1>", 401);
  const { ctx, rid, sid, stub } = s;
  if (ctx.answer !== "open") return answerForm(ctx);
  if (Number(c.req.header("content-length") ?? 0) > MAX_ANSWER_BYTES * 2) return page("Too large", "<h1>The document is too large.</h1>", 413);

  const form = await c.req.formData();
  const file = form.get("file");
  const markdown = file instanceof File && file.size > 0 ? await file.text() : String(form.get("text") ?? "");
  const bytes = new TextEncoder().encode(markdown).byteLength;
  if (bytes > MAX_ANSWER_BYTES) return page("Too large", "<h1>The document is too large.</h1>", 413);

  const sender = `${ctx.identity.givenName} ${ctx.identity.familyName}`;
  const digest = await sha256Hex(markdown);
  let doc: ParsedDoc | null = null;
  let parseError = "";
  try {
    doc = parseAnswer(markdown);
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    parseError = err.message;
  }
  await audit(c.env.DB, {
    requestId: rid,
    event: "answer_sent",
    actor: sender,
    detail: { sha256: digest, bytes, parsed: doc !== null, ...(doc ? { kind: doc.kind } : {}) },
  });
  if (!doc) return answerForm(ctx, `We could not read the document: ${parseError}`);

  // Misdelivery: wrong kind of document, or a document about someone else.
  const wrong: string[] = [];
  if (doc.kind !== ctx.docType) wrong.push("document type");
  if (!sameName(doc.patient.name, ctx.patient.name)) wrong.push("patient name");
  if (doc.patient.birthDate !== ctx.patient.birthDate) wrong.push("patient birth date");
  if (wrong.length) {
    await stub.recordMismatch();
    await audit(c.env.DB, {
      requestId: rid,
      event: "misdelivery_caught",
      actor: "service",
      detail: { mismatch: wrong, sender, sha256: digest, filed: false },
    });
    await notifyRequester(c.env, {
      requestId: rid,
      requester: ctx.requester,
      roomId: ctx.roomId,
      text: `⚠️ ${sender} answered your request for ${ctx.patient.name} with a document that does not match (${wrong.join(", ")}). Nothing was filed.`,
    });
    return answerForm(ctx, "This document is not the one requested, so it was not accepted. Nothing was stored. Please check it and send the right one.");
  }

  if (!(await stub.claimAnswer(sid))) return answerForm(ctx);
  try {
    const bpkHash = ctx.identity.bpk ? (await sha256Hex(ctx.identity.bpk)).slice(0, 16) : undefined;
    const built = buildBundle({
      requestId: rid,
      fhirBase: c.env.FHIR_BASE_URL,
      patientId: ctx.patient.id,
      requester: { mxid: ctx.requester, ...(ctx.requesterName ? { name: ctx.requesterName } : {}) },
      docType: ctx.docType,
      requestedAt: ctx.createdAt,
      now: new Date().toISOString(),
      doc,
      markdown,
      sender: ctx.identity,
      ...(bpkHash ? { senderBpkHash: bpkHash } : {}),
      verifiedAt: ctx.verifiedAt,
    });
    const locations = await fileBundle(c.env, built.bundle);
    await stub.finishAnswer(true);
    await audit(c.env.DB, {
      requestId: rid,
      event: "answer_filed",
      actor: "service",
      detail: { outcome: "filed", sha256: digest, resources: locations },
    });
    const author = doc.kind === "lab-result" ? doc.validatedBy.name : doc.writtenBy.name;
    const onBehalf = matchesName(author, ctx.identity.givenName, ctx.identity.familyName) ? "" : ` on behalf of ${author}`;
    const what = doc.kind === "lab-result" ? `${doc.rows.length} lab values (DiagnosticReport + Observations)` : "the discharge report (DocumentReference)";
    await notifyRequester(c.env, {
      requestId: rid,
      requester: ctx.requester,
      roomId: ctx.roomId,
      text: `✅ ${sender}${onBehalf} sent the ${DOC_LABEL[ctx.docType]} for ${ctx.patient.name}. Identity checked with ${ctx.identity.method} (level ${ctx.identity.loa}). Filed ${what}.`,
    });
    return page("Thank you", "<h1>Thank you.</h1><p>Your answer was received. You can close this window.</p>");
  } catch (err) {
    await stub.finishAnswer(false);
    const message = err instanceof Error ? err.message : "unknown";
    await audit(c.env.DB, { requestId: rid, event: "answer_filed", actor: "service", detail: { outcome: "error", sha256: digest, error: message.slice(0, 300) } });
    await notifyRequester(c.env, { requestId: rid, requester: ctx.requester, roomId: ctx.roomId, text: `❌ An answer from ${sender} could not be filed: ${message.slice(0, 200)}` });
    return page("Could not file", "<h1>We could not store your answer.</h1><p>Nothing was lost on your side. Please try again in a few minutes.</p>", 502);
  }
});

// ---- Matrix application service (Synapse -> Worker) -------------------------

async function fromHomeserver(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const given = (c.req.header("authorization") ?? "").replace(/^Bearer /, "") || (c.req.query("access_token") ?? "");
  return given !== "" && (await secretEquals(given, c.env.HS_TOKEN));
}

app.put("/_matrix/app/v1/transactions/:txnId", async (c) => {
  if (!(await fromHomeserver(c))) return c.json({ errcode: "M_FORBIDDEN" }, 403);
  const { events = [] } = (await c.req.json<{ events?: MatrixEvent[] }>().catch(() => ({}))) as { events?: MatrixEvent[] };
  // Answer at once; Synapse would otherwise retry a slow transaction. Events are deduplicated by id.
  c.executionCtx.waitUntil(processEvents(c.env, events));
  return c.json({});
});
app.get("/_matrix/app/v1/users/:userId", async (c) => ((await fromHomeserver(c)) ? c.json({}) : c.json({ errcode: "M_FORBIDDEN" }, 403)));
app.get("/_matrix/app/v1/rooms/:alias", async (c) => ((await fromHomeserver(c)) ? c.json({ errcode: "M_NOT_FOUND" }, 404) : c.json({ errcode: "M_FORBIDDEN" }, 403)));
app.post("/_matrix/app/v1/ping", async (c) => ((await fromHomeserver(c)) ? c.json({}) : c.json({ errcode: "M_FORBIDDEN" }, 403)));

// ---- Development helpers (mock IdP only) ----------------------------------

app.use("/mock-idp/*", async (c, next) => (mockEnabled(c.env) ? next() : c.notFound()));
app.use("/outbox", async (c, next) => (mockEnabled(c.env) ? next() : c.notFound()));

app.get("/mock-idp/login", (c) => {
  const state = c.req.query("state") ?? "";
  const buttons = Object.entries(MOCK_PEOPLE)
    .map(([key, p]) => `<form method="post"><input type="hidden" name="state" value="${esc(state)}">
<button name="who" value="${esc(key)}">Log in as ${esc(p.givenName)} ${esc(p.familyName)}${p.loa === "high" ? "" : ` (${esc(p.loa)} assurance)`}</button></form>`)
    .join("");
  return page("Mock ID Austria", `<h1>Mock ID Austria</h1><p>Simulated eID. Pick who is logging in.</p>${buttons}`);
});

app.post("/mock-idp/login", async (c) => {
  const form = await c.req.formData();
  const state = String(form.get("state") ?? "");
  const who = String(form.get("who") ?? "");
  return c.redirect(`${c.env.BASE_URL}/auth/callback?state=${encodeURIComponent(state)}&mock=${encodeURIComponent(who)}`, 303);
});

app.get("/outbox", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT ts, channel, to_addr, subject, body, delivery FROM outbox ORDER BY id DESC LIMIT 50",
  ).all<{ ts: string; channel: string; to_addr: string; subject: string; body: string; delivery: string }>();
  const rows = results
    .map((m) => `<tr><td>${esc(m.ts)}</td><td>${esc(m.channel)}</td><td>${esc(m.to_addr)}</td><td>${esc(m.subject)}</td><td><pre>${esc(m.body)}</pre></td><td>${esc(m.delivery)}</td></tr>`)
    .join("");
  const notes = (
    await c.env.DB.prepare("SELECT ts, recipient, text FROM notifications ORDER BY id DESC LIMIT 50").all<{ ts: string; recipient: string; text: string }>()
  ).results
    .map((n) => `<tr><td>${esc(n.ts)}</td><td>${esc(n.recipient)}</td><td>${esc(n.text)}</td></tr>`)
    .join("");
  return page(
    "Outbox",
    `<h1>Simulated mail and SMS</h1><table><tr><th>Time</th><th>Channel</th><th>To</th><th>Subject</th><th>Message</th><th>Delivery</th></tr>${rows}</table>
<h1>Simulated Matrix messages</h1><table><tr><th>Time</th><th>To</th><th>Message</th></tr>${notes}</table>`,
  );
});

export default app;
