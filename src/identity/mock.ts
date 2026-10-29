import type { AuthContext, IdentityProvider, VerifiedIdentity } from "./types";

/** People you can "log in" as, so the three misdelivery tests can run without three real eIDs. */
export const MOCK_PEOPLE: Record<string, VerifiedIdentity> = {
  brandl: { givenName: "Eva", familyName: "Brandl", bpk: "mock-bpk-brandl", loa: "high", method: "mock-id-austria" },
  kern: { givenName: "Stefan", familyName: "Kern", bpk: "mock-bpk-kern", loa: "high", method: "mock-id-austria" },
  kollege: { givenName: "Karl", familyName: "Kollege", bpk: "mock-bpk-kollege", loa: "high", method: "mock-id-austria" },
  stranger: { givenName: "Susi", familyName: "Fremd", bpk: "mock-bpk-fremd", loa: "high", method: "mock-id-austria" },
};

export class MockProvider implements IdentityProvider {
  constructor(private baseUrl: string) {}

  async begin(ctx: AuthContext): Promise<string> {
    return `${this.baseUrl}/mock-idp/login?state=${encodeURIComponent(ctx.state)}`;
  }

  async complete(req: Request): Promise<VerifiedIdentity> {
    const who = new URL(req.url).searchParams.get("mock") ?? "";
    const person = MOCK_PEOPLE[who];
    if (!person) throw new Error("unknown mock identity");
    return person;
  }
}
