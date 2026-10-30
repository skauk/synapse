import { describe, expect, it } from "vitest";
import { planDelivery } from "../src/mail";

const msg = (to: string) => ({ to, subject: "Secure request from a colleague" });

describe("planDelivery", () => {
  it("never sends to reserved domains", () => {
    for (const to of ["eva.brandl@labor-kanal.example", "a@b.test", "a@x.invalid", "a@host.localhost", "a@example.com", "a@mail.example.org"]) {
      expect(planDelivery("", msg(to)).action).toBe("skip");
    }
  });
  it("sends to a real domain", () => {
    expect(planDelivery("", msg("doc@clinic.at"))).toEqual({ action: "send", to: "doc@clinic.at", subject: "Secure request from a colleague" });
  });
  it("rejects an address without a domain", () => {
    expect(planDelivery("", msg("nobody")).action).toBe("skip");
  });
  it("redirects everything to the demo mailbox and says who it was for", () => {
    const plan = planDelivery("me@mine.at", msg("eva.brandl@labor-kanal.example"));
    expect(plan).toMatchObject({ action: "send", to: "me@mine.at" });
    expect((plan as { subject: string }).subject).toContain("meant for eva.brandl@labor-kanal.example");
  });
  it("keeps patient data out of the subject", () => {
    const plan = planDelivery("me@mine.at", msg("x@y.example")) as { subject: string };
    expect(plan.subject).not.toMatch(/Maria|Beispiel|lab|rehab/i);
  });
});
