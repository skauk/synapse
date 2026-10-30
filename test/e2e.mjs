// End-to-end check against a running `wrangler dev` using the mock IdP.
// Usage: BOT_API_TOKEN=... node test/e2e.mjs   (token is read from .dev.vars if unset)
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const local = (u) => u.replace(/^http:\/\/localhost:8787/, BASE); // links the Worker prints point at localhost; inside the test container use BASE
// The token of the Docker demo stack (docker-compose.yml). Override with BOT_API_TOKEN for another deployment.
const TOKEN = process.env.BOT_API_TOKEN ?? "demo-bot-token";

const body = (docType, recipient) => ({
  requester: "@lena.hofer:klinikum.example",
  patient: { id: "maria-beispiel", name: "Maria Beispiel", birthDate: "1961-03-12" },
  docType,
  recipient,
});

async function createRequest(payload) {
  const res = await fetch(`${BASE}/api/requests`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Open the link, click through to the mock IdP, log in as `who`. Returns the final page. */
async function answerAs(link, who) {
  const url = new URL(link);
  const [, , rid, token] = url.pathname.split("/");
  const opened = await fetch(local(link));
  const start = await fetch(`${BASE}/auth/start`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ rid, token }),
  });
  const loginUrl = start.headers.get("location");
  const state = new URL(loginUrl).searchParams.get("state");
  const login = await fetch(local(loginUrl.replace(/\?.*/, "")), {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ state, who }),
  });
  const cb = await fetch(local(login.headers.get("location")), { redirect: "manual" });
  const cookie = cb.headers.get("set-cookie")?.split(";")[0];
  const answer = cookie ? await fetch(`${BASE}/answer`, { headers: { cookie } }) : null;
  return { opened: await opened.text(), callbackStatus: cb.status, callbackBody: await cb.text(), cookie, answer: answer ? await answer.text() : "" };
}

// Patient data and document type must never appear in anything the outsider sees before the identity check.
// Whole words only: "Beispielstadt" (the clinic) and "labor-kanal" (the lab's domain) are fine.
const LEAK = /\bMaria\b|\bBeispiel\b|1961|12 March|lab[ -]result|\brehab|\bblood|clotting|discharge|\bINR\b/i;

const FHIR = process.env.FHIR_BASE_URL ?? "http://localhost:8080/fhir";
const doc = (name) => readFileSync(new URL(`../scenario/documents/${name}`, import.meta.url), "utf8");

/** Submit an answer as a logged-in outsider. */
async function submit(cookie, markdown) {
  const form = new FormData();
  form.set("text", markdown);
  const res = await fetch(`${BASE}/answer`, { method: "POST", headers: { cookie }, body: form });
  return { status: res.status, body: await res.text() };
}

const botHeaders = { authorization: `Bearer ${TOKEN}` };
async function auditOf(id) {
  return (await fetch(`${BASE}/api/requests/${id}/audit`, { headers: botHeaders })).json();
}

async function fhirSearch(query) {
  const res = await fetch(`${FHIR}/${query}`, { headers: { accept: "application/fhir+json" } });
  const bundle = await res.json();
  return (bundle.entry ?? []).map((e) => e.resource);
}

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
}

const brandl = { name: "Dr. Eva Brandl", channel: "email", address: "eva.brandl@labor-kanal.example" };

// Request 1 happy path
const r1 = await createRequest(body("lab-result", brandl));
const ok = await answerAs(r1.link, "brandl");
check("link page shows no patient or document type", !LEAK.test(ok.opened));
check("Dr. Brandl passes the identity check", ok.callbackStatus === 303 && ok.answer.includes("Identity confirmed"));

const filed = await submit(ok.cookie, doc("lab-result-maria-beispiel.md"));
check("lab result accepted", filed.status === 200 && filed.body.includes("Thank you"));
const obs = await fhirSearch(`Observation?based-on=ServiceRequest/sr-${r1.id}&_count=20`);
check("4 Observations filed with LOINC codes", obs.length === 4 && obs.every((o) => o.code.coding[0].system === "http://loinc.org"));
const reports = await fhirSearch(`DiagnosticReport?based-on=ServiceRequest/sr-${r1.id}`);
check("DiagnosticReport references all 4 Observations", reports.length === 1 && reports[0].result.length === 4);
const prov = await fhirSearch(`Provenance?_id=prov-${r1.id}`);
check("Provenance records ID check and covers 5 resources", prov.length === 1 && prov[0].target.length === 5 && JSON.stringify(prov[0]).includes("mock-id-austria-high"));
const again = await submit(ok.cookie, doc("lab-result-maria-beispiel.md"));
const obsAfter = await fhirSearch(`Observation?based-on=ServiceRequest/sr-${r1.id}&_count=20`);
check("second answer is refused and nothing is filed twice", again.body.includes("already been received") && obsAfter.length === 4);

// M1: wrong address, a stranger opens the link
const m1 = await createRequest(body("lab-result", { ...brandl, address: "eva.brandl@labor-kanaI.example" }));
const stranger = await answerAs(m1.link, "stranger");
check("M1: stranger is rejected", stranger.callbackStatus === 403 && !stranger.cookie);
const m1audit = await auditOf(m1.id);
const m1check = m1audit.find((e) => e.event === "identity_checked");
check("M1: the failed identity check is in the audit log", m1check?.detail.outcome === "fail" && m1check.detail.reason === "name_mismatch" && m1check.actor.includes("Fremd"));
check("M1: rejection reveals nothing", stranger.callbackBody.length > 0 && !LEAK.test(stranger.callbackBody) && !/Brandl/.test(stranger.callbackBody));

// Right person, eID below the required level
const lowLevel = await createRequest(body("lab-result", brandl));
const low = await answerAs(lowLevel.link, "brandllow");
check("a low-assurance eID is refused even for the right person", low.callbackStatus === 403 && !low.cookie);
const lowAudit = await auditOf(lowLevel.id);
check("the refusal is audited with the levels", lowAudit.some((e) => e.event === "identity_checked" && e.detail.reason === "assurance_too_low" && e.detail.loa === "low"));
check("a high-assurance eID passes the same check", ok.callbackStatus === 303);

// M2: forwarded to a colleague
const m2 = await createRequest(body("lab-result", brandl));
const colleague = await answerAs(m2.link, "kollege");
check("M2: colleague is rejected", colleague.callbackStatus === 403 && !colleague.cookie);

// M3: right person, wrong patient (Max instead of Maria)
const m3 = await createRequest(body("lab-result", brandl));
const m3session = await answerAs(m3.link, "brandl");
const max = await submit(m3session.cookie, doc("lab-result-max-beispiel.md"));
check("M3: Max's result is refused", !max.body.includes("Thank you") && max.body.includes("not accepted"));
check("M3: nothing filed for this request", (await fhirSearch(`Observation?based-on=ServiceRequest/sr-${m3.id}`)).length === 0);
check("M3: wrong-patient page does not echo the other patient", !/\bMax\b|1960/.test(max.body));
const wrongType = await submit(m3session.cookie, doc("rehab-report-maria-beispiel.md"));
check("wrong document type is refused", !wrongType.body.includes("Thank you") && wrongType.body.includes("not accepted"));
const garbage = await submit(m3session.cookie, "hello");
check("unreadable document is refused with a reason", garbage.status === 422 && garbage.body.includes("could not read"));
const maria = await submit(m3session.cookie, doc("lab-result-maria-beispiel.md"));
check("M3: correct document is accepted afterwards", maria.body.includes("Thank you"));

const m2audit = await auditOf(m2.id);
check("M2: the forwarded attempt is in the audit log", m2audit.some((e) => e.event === "identity_checked" && e.detail.outcome === "fail" && e.actor.includes("Kollege")));
check("M2: nothing filed for the colleague", (await fhirSearch(`DiagnosticReport?based-on=ServiceRequest/sr-${m2.id}`)).length === 0);

// Request 2 (SMS to Stefan Kern)
const r2 = await createRequest(body("rehab-report", { name: "Stefan Kern", channel: "sms", address: "+43 660 000 0101" }));
const kern = await answerAs(r2.link, "kern");
check("Request 2: Stefan Kern passes", kern.answer.includes("Identity confirmed"));
const sent = await submit(kern.cookie, doc("rehab-report-maria-beispiel.md"));
check("rehab report accepted", sent.body.includes("Thank you"));
const refs = await fhirSearch(`DocumentReference?_id=docref-${r2.id}`);
check("DocumentReference has the text attached", refs.length === 1 && Buffer.from(refs[0].content[0].attachment.data, "base64").toString().includes("Rivaroxaban"));
const prov2 = await fhirSearch(`Provenance?_id=prov-${r2.id}`);
check("rehab Provenance names author and sender separately", prov2.length === 1 && prov2[0].agent.length === 2);

// Outbound messages must be free of patient data
const outbox = await (await fetch(`${BASE}/outbox`)).text();
const [mailAndSms = "", matrixMessages = ""] = outbox.split("Simulated Matrix messages");
check("email and SMS have no patient name, birth date or document type", mailAndSms.length > 0 && !LEAK.test(mailAndSms));

check("Matrix messages: filed notices and mismatch warnings", /✅/.test(matrixMessages) && /does not match/.test(matrixMessages));

// Audit coverage: all six steps, each with who, what and when, in a chain nobody has edited.
const AUDIT_STEPS = ["request_sent", "link_opened", "identity_checked", "answer_sent", "answer_filed", "misdelivery_caught"];
const trail = [...(await auditOf(r1.id)), ...(await auditOf(m3.id))];
const covered = AUDIT_STEPS.filter((step) => trail.some((e) => e.event === step));
check(`audit coverage: ${covered.length} of 6 steps logged`, covered.length === 6);
check("every audit entry has who, what and when", trail.every((e) => e.actor && e.event && !Number.isNaN(Date.parse(e.ts)) && e.detail));
const order = (await auditOf(r1.id)).map((e) => e.event);
check("request 1 steps are in order", order.join() === "request_sent,link_opened,identity_checked,answer_sent,answer_filed");
const chain = await (await fetch(`${BASE}/api/audit/verify`, { headers: botHeaders })).json();
check(`audit hash chain is intact (${chain.count} entries)`, chain.ok === true);
check("audit API refuses callers without the token", (await fetch(`${BASE}/api/requests/${r1.id}/audit`)).status === 401);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
