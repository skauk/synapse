// One-shot: create the host account (admin), the registration token for the judges and the public room
// "External requests" with the bot invited. Safe to run again.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const HS = "http://synapse:8008";
const BOT = "@pgkbot:klinikum.example";
const HOST = { user: "host", password: process.env.HOST_PASSWORD, name: "Dr. Lena Hofer (host)" };
const JUDGE_TOKEN = process.env.JUDGE_TOKEN;
if (!HOST.password || !JUDGE_TOKEN) throw new Error("HOST_PASSWORD and JUDGE_TOKEN are required");

for (let i = 0; i < 90; i++) {
  try {
    if ((await fetch(`${HS}/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
}

const secret = readFileSync("/synapse-data/homeserver.yaml", "utf8").match(/^registration_shared_secret:\s*"?([^"\n]+)"?/m)?.[1];
if (!secret) throw new Error("registration_shared_secret not found");
const { nonce } = await (await fetch(`${HS}/_synapse/admin/v1/register`)).json();
const mac = createHmac("sha1", secret).update(`${nonce}\0${HOST.user}\0${HOST.password}\0admin`).digest("hex");
const reg = await fetch(`${HS}/_synapse/admin/v1/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ nonce, username: HOST.user, password: HOST.password, admin: true, displayname: HOST.name, mac }),
});
const regBody = await reg.json();
if (!reg.ok && regBody.errcode !== "M_USER_IN_USE") throw new Error(`register: ${JSON.stringify(regBody)}`);

const login = await (
  await fetch(`${HS}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: HOST.user }, password: HOST.password }),
  })
).json();
if (!login.access_token) throw new Error(`login: ${JSON.stringify(login)}`);
const auth = { authorization: `Bearer ${login.access_token}`, "content-type": "application/json" };

const tok = await fetch(`${HS}/_synapse/admin/v1/registration_tokens/new`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ token: JUDGE_TOKEN, uses_allowed: null }),
});
console.log(tok.ok ? "registration token created" : `registration token: ${tok.status} (exists already?)`);

const rooms = (await (await fetch(`${HS}/_matrix/client/v3/joined_rooms`, { headers: auth })).json()).joined_rooms ?? [];
let roomId;
for (const id of rooms) {
  const n = await (await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name`, { headers: auth })).json();
  if (n.name === "External requests") roomId = id;
}
if (!roomId) {
  const res = await fetch(`${HS}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers: auth,
    // Public so judges can join without an invitation. Not encrypted: the bot cannot read encrypted rooms.
    body: JSON.stringify({ name: "External requests", invite: [BOT], preset: "public_chat", visibility: "public" }),
  });
  if (!res.ok) throw new Error(`createRoom: ${await res.text()}`);
  roomId = (await res.json()).room_id;
  console.log("room created, bot invited");
} else console.log("room exists");

// A stable alias for the invitation link, and a listing in the room directory.
const ALIAS = "#requests:klinikum.example";
const alias = await fetch(`${HS}/_matrix/client/v3/directory/room/${encodeURIComponent(ALIAS)}`, {
  method: "PUT",
  headers: auth,
  body: JSON.stringify({ room_id: roomId }),
});
console.log(alias.ok ? `alias ${ALIAS} set` : `alias: ${alias.status} (exists already?)`);
const listed = await fetch(`${HS}/_matrix/client/v3/directory/list/room/${encodeURIComponent(roomId)}`, {
  method: "PUT",
  headers: auth,
  body: JSON.stringify({ visibility: "public" }),
});
console.log(listed.ok ? "listed in the room directory" : `directory listing: ${listed.status} ${await listed.text()}`);
console.log("seed done");
