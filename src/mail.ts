import { esc } from "./html";

/** Addresses on these domains cannot receive mail. Sending to them only creates bounces. */
const RESERVED = /(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|org|net)$/i;

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type Plan = { action: "skip"; reason: string } | { action: "send"; to: string; subject: string };

/**
 * Decide where a message really goes. With a redirect address every message goes there (for demos), marked in
 * the subject with the address it was meant for. Without one, reserved domains are never sent to.
 */
export function planDelivery(redirectTo: string, input: Pick<MailInput, "to" | "subject">): Plan {
  if (redirectTo) return { action: "send", to: redirectTo, subject: `[demo, meant for ${input.to}] ${input.subject}` };
  const domain = input.to.split("@")[1] ?? "";
  if (!domain || RESERVED.test(domain)) return { action: "skip", reason: `${domain || "address"} is a reserved domain and cannot receive mail` };
  return { action: "send", to: input.to, subject: input.subject };
}

export function requestMail(env: Env, to: string, sender: string, link: string): MailInput {
  const org = env.SENDER_ORG;
  return {
    to,
    subject: "Secure request from a colleague",
    text: `A colleague (${sender}) at ${org} sent you a secure request.\nOpen it and identify yourself: ${link}\nThe link works for 7 days.\n\nIf you do not expect this message, ignore it. Nothing is shared until you identify yourself.`,
    html: `<p>A colleague (${esc(sender)}) at ${esc(org)} sent you a secure request.</p>
<p><a href="${esc(link)}">Open the request and identify yourself</a></p>
<p>The link works for 7 days. If you do not expect this message, ignore it. Nothing is shared until you identify yourself.</p>`,
  };
}

/**
 * Deliver a message according to MAIL_MODE: "cloudflare" (Cloudflare Email Service), "mailpit" (a local mail
 * catcher that accepts any address) or "outbox" (only record it). Returns the delivery status. Never throws.
 */
export async function deliverMail(env: Env, input: MailInput): Promise<string> {
  if (env.MAIL_MODE === "mailpit") {
    try {
      const res = await fetch(`${env.MAILPIT_URL}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: { Email: env.MAIL_FROM, Name: env.MAIL_FROM_NAME },
          To: [{ Email: input.to }],
          Subject: input.subject,
          Text: input.text,
          HTML: input.html,
        }),
      });
      if (!res.ok) throw new Error(`Mailpit answered ${res.status}`);
      return "caught by Mailpit";
    } catch (err) {
      return `failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
    }
  }
  if (env.MAIL_MODE !== "cloudflare") return "simulated";
  const plan = planDelivery(env.MAIL_REDIRECT_TO, input);
  if (plan.action === "skip") return `not sent: ${plan.reason}`;
  try {
    const sent = await env.EMAIL.send({
      to: plan.to,
      from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME },
      subject: plan.subject,
      text: input.text,
      html: input.html,
    });
    return `${plan.to === input.to ? "sent" : "redirected"}: ${sent.messageId}`;
  } catch (err) {
    return `failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
  }
}
