// The open demo mode: anyone in the room may use the bot, each user gets BOT_MAX_MESSAGES commands, and the bot
// answers only on BOT_ACTIVE_DATE. Needs the Docker stack with the worker started in that mode:
//   MATRIX_OPEN=true BOT_MAX_MESSAGES=3 docker compose up -d worker && node test/limit-e2e.mjs limit
//   MATRIX_OPEN=true BOT_MAX_MESSAGES=3 BOT_ACTIVE_DATE=2000-01-01 docker compose up -d worker && node test/limit-e2e.mjs closed
// Events are posted to the application service endpoint with the homeserver token, as Synapse would.
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const HS = process.env.MATRIX_URL ?? "http://localhost:8008";
const MODE = process.argv[2] ?? "limit";
const LIMIT = Number(process.env.BOT_MAX_MESSAGES ?? 3);
const HS_TOKEN = process.env.HS_TOKEN ?? "demo-hs-token-local-only";

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await (
  await fetch(`${HS}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: "lena.hofer" }, password: "demo-only-lena" }),
  })
).json();
const auth = { authorization: `Bearer ${login.access_token}`, "content-type": "application/json" };
let ROOM;
for (const id of (await (await fetch(`${HS}/_matrix/client/v3/joined_rooms`, { headers: auth })).json()).joined_rooms) {
  const n = await (await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name`, { headers: auth })).json();
  if (n.name === "External requests") ROOM = id;
}
if (!ROOM) throw new Error("room not found");

async function botMessages() {
  const res = await (await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/messages?dir=b&limit=50`, { headers: auth })).json();
  return res.chunk.filter((e) => e.type === "m.room.message" && e.sender === "@pgkbot:klinikum.example").map((e) => ({ id: e.event_id, body: e.content.body }));
}
const seen = new Set((await botMessages()).map((m) => m.id));

/** Post a command as `sender` and return the bot's new reply, if any, within `wait` ms. */
async function command(sender, body, wait = 6000) {
  const event = { type: "m.room.message", event_id: `$limit-${crypto.randomUUID()}`, room_id: ROOM, sender, content: { msgtype: "m.text", body } };
  const res = await fetch(`${BASE}/_matrix/app/v1/transactions/${crypto.randomUUID()}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${HS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ events: [event] }),
  });
  if (!res.ok) throw new Error(`transaction refused: ${res.status}`);
  for (let t = 0; t < wait; t += 500) {
    const fresh = (await botMessages()).find((m) => !seen.has(m.id));
    if (fresh) {
      seen.add(fresh.id);
      return fresh.body;
    }
    await sleep(500);
  }
  return null;
}

const judge1 = `@judge1:klinikum.example`;
const judge2 = `@judge2:klinikum.example`;

if (MODE === "limit") {
  for (let i = 1; i <= LIMIT; i++) {
    const reply = await command(judge1, "!help");
    check(`message ${i} of ${LIMIT} is answered`, !!reply && /!request lab/.test(reply));
  }
  const notice = await command(judge1, "!help");
  check("the next message gets a single notice", !!notice && notice.includes(judge1) && /will not answer more/.test(notice));
  check("further messages are ignored silently", (await command(judge1, "!help", 3000)) === null);
  check("another user has their own allowance", /!request lab/.test((await command(judge2, "!help")) ?? ""));
  check("a user outside the member list may use the bot in open mode", !/Only members/.test((await command(judge2, "!help")) ?? ""));
} else {
  const reply = await command(judge1, "!help");
  check("outside the active date the bot says it is closed", !!reply && /only open on 2000-01-01/.test(reply));
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
