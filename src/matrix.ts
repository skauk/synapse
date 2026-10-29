import { createRequest } from "./create-request";
import { findPatient } from "./fhir-client";
import type { DocType } from "./request-do";

/** Matrix application service: Synapse pushes room events here, the bot answers through the client API. */

export interface MatrixEvent {
  type: string;
  event_id: string;
  room_id: string;
  sender: string;
  state_key?: string;
  content: { membership?: string; msgtype?: string; body?: string };
}

const enc = encodeURIComponent;

async function api(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`${env.MATRIX_HOMESERVER_URL}/_matrix/client/v3${path}${sep}user_id=${enc(env.MATRIX_BOT_USER)}`, {
    method,
    headers: { authorization: `Bearer ${env.AS_TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function sendMessage(env: Env, roomId: string, text: string): Promise<void> {
  const res = await api(env, "PUT", `/rooms/${enc(roomId)}/send/m.room.message/${crypto.randomUUID()}`, { msgtype: "m.text", body: text });
  if (!res.ok) throw new Error(`Matrix send failed: ${res.status}`);
}

async function joinRoom(env: Env, roomId: string): Promise<void> {
  const res = await api(env, "POST", `/rooms/${enc(roomId)}/join`, {});
  if (!res.ok) throw new Error(`Matrix join failed: ${res.status}`);
}

async function displayName(env: Env, mxid: string): Promise<string | undefined> {
  const res = await fetch(`${env.MATRIX_HOMESERVER_URL}/_matrix/client/v3/profile/${enc(mxid)}`);
  if (!res.ok) return undefined;
  return (await res.json<{ displayname?: string }>()).displayname;
}

/** Words, with "double quoted phrases" kept together. */
export function tokenize(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
}

export type Command =
  | { kind: "help" }
  | { kind: "request"; docType: DocType; recipientName: string; channel: "email" | "sms"; address: string; patient: string };

export const HELP = [
  "I request documents from people outside the network.",
  '!request lab "Dr. Eva Brandl" eva.brandl@labor-kanal.example maria-beispiel',
  '!request rehab "Stefan Kern" "+43 660 000 0101" maria-beispiel',
  "Format: !request <lab|rehab> \"<name of the person>\" <email or mobile number> <patient id or MRN>",
].join("\n");

export function parseCommand(body: string): Command | { error: string } {
  const [cmd, ...args] = tokenize(body.trim());
  if (cmd === "!help") return { kind: "help" };
  if (cmd !== "!request") return { error: `Unknown command ${cmd}. Try !help.` };
  const [type, name, contact, patient] = args;
  if (args.length !== 4 || !type || !name || !contact || !patient) return { error: `That needs four parts.\n${HELP}` };
  const docType: DocType | null = type === "lab" ? "lab-result" : type === "rehab" ? "rehab-report" : null;
  if (!docType) return { error: `Document type must be “lab” or “rehab”, not “${type}”.` };
  if (contact.includes("@")) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return { error: `“${contact}” is not a valid email address.` };
    return { kind: "request", docType, recipientName: name, channel: "email", address: contact, patient };
  }
  if (!/^\+?[\d\s/-]{7,}$/.test(contact)) return { error: `“${contact}” is neither an email address nor a phone number.` };
  return { kind: "request", docType, recipientName: name, channel: "sms", address: contact, patient };
}

async function handleMessage(env: Env, ev: MatrixEvent): Promise<void> {
  const reply = (text: string) => sendMessage(env, ev.room_id, text);
  const members = env.MATRIX_MEMBERS.split(",").map((m) => m.trim());
  if (!members.includes(ev.sender)) {
    await reply("Only members of the network can send requests.");
    return;
  }
  const cmd = parseCommand(ev.content.body ?? "");
  if ("error" in cmd) return reply(cmd.error);
  if (cmd.kind === "help") return reply(HELP);

  const patient = await findPatient(env, cmd.patient);
  if (!patient) return reply(`I found no patient “${cmd.patient}”.`);
  const requesterName = await displayName(env, ev.sender);
  const { link } = await createRequest(env, {
    requester: ev.sender,
    ...(requesterName ? { requesterName } : {}),
    roomId: ev.room_id,
    patient,
    docType: cmd.docType,
    recipient: { name: cmd.recipientName, channel: cmd.channel, address: cmd.address },
  });
  const via = cmd.channel === "email" ? `email to ${cmd.address}` : `SMS to ${cmd.address}`;
  await reply(
    `Request sent to ${cmd.recipientName} by ${via}. I will tell you here when they answer.` +
      (env.IDP === "mock" && env.BASE_URL.startsWith("http://localhost") ? `\n(demo link: ${link})` : ""),
  );
}

async function handleEvent(env: Env, ev: MatrixEvent): Promise<void> {
  if (ev.sender === env.MATRIX_BOT_USER) return;
  const members = env.MATRIX_MEMBERS.split(",").map((m) => m.trim());
  if (ev.type === "m.room.member" && ev.state_key === env.MATRIX_BOT_USER && ev.content.membership === "invite") {
    if (members.includes(ev.sender)) await joinRoom(env, ev.room_id);
    return;
  }
  if (ev.type === "m.room.message" && ev.content.msgtype === "m.text" && ev.content.body?.startsWith("!")) {
    await handleMessage(env, ev);
  }
}

/** Process each event once, even when Synapse resends the transaction. */
export async function processEvents(env: Env, events: MatrixEvent[]): Promise<void> {
  for (const ev of events) {
    const seen = await env.DB.prepare("INSERT OR IGNORE INTO matrix_events (event_id, ts) VALUES (?, ?)")
      .bind(ev.event_id, new Date().toISOString())
      .run();
    if (seen.meta.changes === 0) continue;
    try {
      await handleEvent(env, ev);
    } catch (err) {
      console.error("matrix event failed", ev.event_id, err instanceof Error ? err.message : err);
    }
  }
}
