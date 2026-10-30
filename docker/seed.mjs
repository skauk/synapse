// One-shot: load the scenario patient into HAPI, create Dr. Hofer's and a guest account on Synapse, and make
// the room "External requests" with the bot invited. Safe to run again.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const FHIR = process.env.FHIR_BASE_URL ?? "http://hapi:8080/fhir";
const HS = process.env.MATRIX_URL ?? "http://synapse:8008";
const SERVER = "klinikum.example";
const BOT = `@pgkbot:${SERVER}`;
const DOCTOR = { user: "lena.hofer", password: "demo-only-lena", name: "Dr. Lena Hofer" };
const GUEST = { user: "gast", password: "demo-only-gast", name: "Guest (not in the network)" };

async function waitFor(url, label) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} did not become ready`);
}

await waitFor(`${FHIR}/metadata`, "HAPI");
const patient = JSON.parse(readFileSync(new URL("../scenario/patient.json", import.meta.url), "utf8"));
const put = await fetch(`${FHIR}/Patient/${patient.id}`, { method: "PUT", headers: { "content-type": "application/fhir+json" }, body: JSON.stringify(patient) });
if (!put.ok) throw new Error(`patient: ${put.status} ${await put.text()}`);
console.log("patient loaded");

await waitFor(`${HS}/health`, "Synapse");
const secret = readFileSync("/synapse-data/homeserver.yaml", "utf8").match(/^registration_shared_secret:\s*"?([^"\n]+)"?/m)?.[1];
if (!secret) throw new Error("registration_shared_secret not found in homeserver.yaml");

async function register({ user, password, name }) {
  const { nonce } = await (await fetch(`${HS}/_synapse/admin/v1/register`)).json();
  const mac = createHmac("sha1", secret).update(`${nonce}\0${user}\0${password}\0notadmin`).digest("hex");
  const res = await fetch(`${HS}/_synapse/admin/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, username: user, password, admin: false, displayname: name, mac }),
  });
  const body = await res.json();
  if (!res.ok && body.errcode !== "M_USER_IN_USE") throw new Error(`register ${user}: ${JSON.stringify(body)}`);
  console.log(res.ok ? `created ${user}` : `${user} exists`);
}
await register(DOCTOR);
await register(GUEST);

const login = await (
  await fetch(`${HS}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: DOCTOR.user }, password: DOCTOR.password }),
  })
).json();
const auth = { authorization: `Bearer ${login.access_token}`, "content-type": "application/json" };

const rooms = (await (await fetch(`${HS}/_matrix/client/v3/joined_rooms`, { headers: auth })).json()).joined_rooms ?? [];
let found = false;
for (const id of rooms) {
  const name = await (await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name`, { headers: auth })).json();
  if (name.name === "External requests") found = true;
}
if (!found) {
  const res = await fetch(`${HS}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers: auth,
    // Not encrypted on purpose: the bot cannot read end-to-end encrypted rooms.
    body: JSON.stringify({ name: "External requests", invite: [BOT], preset: "private_chat" }),
  });
  if (!res.ok) throw new Error(`createRoom: ${await res.text()}`);
  console.log("room created, bot invited");
} else console.log("room exists");
console.log("seed done");
