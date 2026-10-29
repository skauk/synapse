// Full flow through Matrix: Dr. Hofer asks in her room, the outsider answers in the browser, the bot reports back.
// Needs: docker compose up (hapi, synapse), scripts/matrix-setup.sh, and `npm run dev` (mock IdP).
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const HS = process.env.MATRIX_URL ?? "http://localhost:8008";
const ROOM = readFileSync(new URL("../matrix/room.txt", import.meta.url), "utf8").trim();
const doc = (name) => readFileSync(new URL(`../scenario/documents/${name}`, import.meta.url), "utf8");

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
}

/** Log in, waiting when Synapse's login rate limit says so. Fails loudly on any other error. */
async function loginAs(user, password) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${HS}/_matrix/client/v3/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user }, password }),
    });
    const body = await res.json();
    if (body.access_token) return { authorization: `Bearer ${body.access_token}`, "content-type": "application/json" };
    if (body.errcode !== "M_LIMIT_EXCEEDED") throw new Error(`login as ${user} failed: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, (body.retry_after_ms ?? 5000) + 200));
  }
  throw new Error(`login as ${user} kept hitting the rate limit`);
}
const auth = await loginAs("lena.hofer", "demo-only-lena");

/** Send a message as `headers`' user. Throws with Synapse's error, so a rejected message is not mistaken for a silent bot. */
async function sendAs(headers, text) {
  const res = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/send/m.room.message/${crypto.randomUUID()}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ msgtype: "m.text", body: text }),
  });
  if (!res.ok) throw new Error(`Matrix rejected the message (${res.status}): ${await res.text()}`);
}
const say = (text) => sendAs(auth, text);

/** Bot messages in the room, newest first. Messages are told apart by event id, so reruns see only new ones. */
async function botMessages() {
  const res = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/messages?dir=b&limit=50`, { headers: auth });
  return (await res.json()).chunk
    .filter((e) => e.type === "m.room.message" && e.sender === "@pgkbot:klinikum.example")
    .map((e) => ({ id: e.event_id, body: e.content.body }));
}

async function waitForBot(pattern, seconds = 20) {
  for (let i = 0; i < seconds * 2; i++) {
    const hit = (await botMessages()).find((m) => pattern.test(m.body) && !seen.has(m.id));
    if (hit) {
      seen.add(hit.id);
      return hit.body;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Open the demo link, identify as `who` with the mock IdP, return the session cookie. */
async function identifyAs(link, who) {
  const [, , rid, token] = new URL(link).pathname.split("/");
  await fetch(link);
  const start = await fetch(`${BASE}/auth/start`, { method: "POST", redirect: "manual", body: new URLSearchParams({ rid, token }) });
  const loginUrl = start.headers.get("location");
  const state = new URL(loginUrl).searchParams.get("state");
  const idp = await fetch(loginUrl.replace(/\?.*/, ""), { method: "POST", redirect: "manual", body: new URLSearchParams({ state, who }) });
  const cb = await fetch(idp.headers.get("location"), { redirect: "manual" });
  return cb.headers.get("set-cookie")?.split(";")[0];
}

async function answer(cookie, markdown) {
  const form = new FormData();
  form.set("text", markdown);
  return (await fetch(`${BASE}/answer`, { method: "POST", headers: { cookie }, body: form })).text();
}

const seen = new Set((await botMessages()).map((m) => m.id));

await say("!help");
const help = await waitForBot(/!request lab/);
check("bot answers !help", !!help);

await say('!request lab "Dr. Eva Brandl" eva.brandl@labor-kanal.example no-such-patient');
check("unknown patient is reported", !!(await waitForBot(/found no patient/)));

await say("!request lab Eva");
check("malformed command is explained", !!(await waitForBot(/needs four parts/)));

// Request 1, answered correctly
await say('!request lab "Dr. Eva Brandl" eva.brandl@labor-kanal.example maria-beispiel');
const sent = await waitForBot(/Request sent to Dr\. Eva Brandl by email/);
check("request 1 is confirmed in the room", !!sent);
check("confirmation names the recipient, not the patient", !!sent && !/Maria|Beispiel/.test(sent.split("(demo link")[0]));
const link = sent?.match(/demo link: ([^\s)]+)/)?.[1];
const cookie = await identifyAs(link, "brandl");
await answer(cookie, doc("lab-result-maria-beispiel.md"));
const filed = await waitForBot(/✅.*Maria Beispiel/);
check("Dr. Hofer is told the result is filed", !!filed && /ID Austria|id-austria/.test(filed));

// Someone who is not in the network directory gets nothing
const room = encodeURIComponent(ROOM);
const countMails = async () => ((await (await fetch(`${BASE}/outbox`)).text()).match(/eva\.brandl@labor-kanal\.example/g) ?? []).length;
const mailsBefore = await countMails();
const guest = await loginAs("gast", "demo-only-gast");
const step = async (path, headers, body) => {
  const res = await fetch(`${HS}/_matrix/client/v3/rooms/${room}/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Matrix ${path} failed (${res.status}): ${await res.text()}`);
};
await step("invite", auth, { user_id: "@gast:klinikum.example" });
await step("join", guest, {});
await sendAs(guest, '!request lab "Dr. Eva Brandl" eva.brandl@labor-kanal.example maria-beispiel');
check("non-member is refused", !!(await waitForBot(/Only members of the network/)));
await step("leave", guest, {});
check("non-member's request created nothing", mailsBefore > 0 && (await countMails()) === mailsBefore);

// Synapse resends a transaction until it gets a 200: the same event must run once
const HS_TOKEN = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^HS_TOKEN=(.+)$/m)?.[1];
const event = {
  type: "m.room.message",
  event_id: `$dedupe-${crypto.randomUUID()}`,
  room_id: ROOM,
  sender: "@lena.hofer:klinikum.example",
  content: { msgtype: "m.text", body: '!request lab "Dr. Dedupe Test" dedupe@labor-kanal.example maria-beispiel' },
};
const put = (txn, token) =>
  fetch(`${BASE}/_matrix/app/v1/transactions/${txn}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ events: [event] }),
  });
check("transaction with a wrong homeserver token is refused", (await put("t0", "wrong")).status === 403);
const idsBefore = new Set((await botMessages()).map((m) => m.id));
const first = await put("t1", HS_TOKEN);
const retry = await put("t1", HS_TOKEN);
const again = await put("t2", HS_TOKEN);
check("transactions are acknowledged with 200", first.status === 200 && retry.status === 200 && again.status === 200);
await waitForBot(/Request sent to Dr\. Dedupe Test/);
await new Promise((r) => setTimeout(r, 3000));
const dupes = (await botMessages()).filter((m) => /Request sent to Dr\. Dedupe Test/.test(m.body) && !idsBefore.has(m.id));
check("a resent event creates only one request", dupes.length === 1);

// M3 through Matrix: Max's document for Maria's request
await say('!request lab "Dr. Eva Brandl" eva.brandl@labor-kanal.example KB-000123');
const sent2 = (await waitForBot(/Request sent to Dr\. Eva Brandl/)) ?? "";
check("patient can be found by MRN", sent2.includes("demo link"));
const cookie2 = await identifyAs(sent2.match(/demo link: ([^\s)]+)/)?.[1], "brandl");
await answer(cookie2, doc("lab-result-max-beispiel.md"));
const warning = await waitForBot(/⚠️.*does not match/);
check("M3: Dr. Hofer is warned in her room", !!warning && /patient name/.test(warning) && /Nothing was filed/.test(warning));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
