import { sendMessage } from "./matrix";

/** Tell the requesting doctor what happened: in her Matrix room, and in D1 as a log. */
export async function notifyRequester(
  env: Env,
  n: { requestId: string; requester: string; roomId?: string; text: string },
): Promise<void> {
  await env.DB.prepare("INSERT INTO notifications (ts, request_id, recipient, text) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), n.requestId, n.requester, n.text)
    .run();
  if (!n.roomId) return;
  try {
    await sendMessage(env, n.roomId, n.text);
  } catch (err) {
    // A Matrix outage must not undo a filed answer. The audit log and D1 still have it.
    console.error("could not notify Matrix room", err instanceof Error ? err.message : err);
  }
}
