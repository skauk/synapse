import { audit } from "./audit";
import type { NewRequest } from "./request-do";
import { randomToken, requestStub, sha256Hex } from "./util";

const LINK_TTL_MS = 7 * 24 * 3600 * 1000;

export type RequestInput = Omit<NewRequest, "id" | "tokenHash" | "expiresAt">;

/** Create the request, "send" the generic email or SMS and write the first audit entry. */
export async function createRequest(env: Env, input: RequestInput): Promise<{ id: string; link: string }> {
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
  const mail =
    input.recipient.channel === "email"
      ? {
          subject: "Secure request from a colleague",
          body: `A colleague (${input.requester}) at ${env.SENDER_ORG} sent you a secure request.\nOpen it and identify yourself: ${link}\nThe link works for 7 days.`,
        }
      : { subject: "", body: `Secure request from ${env.SENDER_ORG}. Open: ${link}` };
  await env.DB.prepare("INSERT INTO outbox (ts, request_id, channel, to_addr, subject, body) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(new Date().toISOString(), id, input.recipient.channel, input.recipient.address, mail.subject, mail.body)
    .run();

  await audit(env.DB, {
    requestId: id,
    event: "request_sent",
    actor: input.requester,
    detail: { channel: input.recipient.channel, to: input.recipient.address, docType: input.docType },
  });
  return { id, link };
}
