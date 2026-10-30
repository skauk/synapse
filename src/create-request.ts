import { audit } from "./audit";
import type { NewRequest } from "./request-do";
import { deliverMail, requestMail } from "./mail";
import { randomToken, requestStub, sha256Hex } from "./util";

const LINK_TTL_MS = 7 * 24 * 3600 * 1000;

export type RequestInput = Omit<NewRequest, "id" | "tokenHash" | "expiresAt">;

/**
 * Create the request, send the generic email (or "SMS") and write the first audit entry.
 * `delivery` says what happened to the message, so a bounce or an outage is never silent.
 */
export async function createRequest(env: Env, input: RequestInput): Promise<{ id: string; link: string; delivery: string }> {
  const id = crypto.randomUUID();
  const token = randomToken();
  await requestStub(env, id).init({
    ...input,
    id,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(Date.now() + LINK_TTL_MS).toISOString(),
  });

  // Nothing about the patient or the document type leaves the service.
  const link = `${env.BASE_URL}/r/${id}/${token}`;
  let mail: { subject: string; body: string };
  let delivery: string;
  if (input.recipient.channel === "email") {
    const message = requestMail(env, input.recipient.address, input.requester, link);
    delivery = await deliverMail(env, message);
    mail = { subject: message.subject, body: message.text };
  } else {
    // No SMS gateway yet: the message only appears in the simulated outbox.
    delivery = "simulated (no SMS gateway)";
    mail = { subject: "", body: `Secure request from ${env.SENDER_ORG}. Open: ${link}` };
  }
  await env.DB.prepare("INSERT INTO outbox (ts, request_id, channel, to_addr, subject, body, delivery) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(new Date().toISOString(), id, input.recipient.channel, input.recipient.address, mail.subject, mail.body, delivery)
    .run();

  await audit(env.DB, {
    requestId: id,
    event: "request_sent",
    actor: input.requester,
    detail: { channel: input.recipient.channel, to: input.recipient.address, docType: input.docType, delivery },
  });
  return { id, link, delivery };
}
