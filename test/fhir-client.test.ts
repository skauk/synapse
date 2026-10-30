import { afterEach, describe, expect, it, vi } from "vitest";
import type { Resource } from "../src/fhir";
import { fileBundle, reuseExisting, serverError } from "../src/fhir-client";

const env = { FHIR_BASE_URL: "http://fhir.test/baseR4" } as unknown as Env;

function bundle(): Resource {
  const org = { resourceType: "Organization", id: "org-new", name: "Labor Kanalstraße" } as Resource;
  const obs = { resourceType: "Observation", id: "obs-1", performer: [{ reference: "Organization/org-new" }, { reference: "Practitioner/p1" }] } as Resource;
  const prac = { resourceType: "Practitioner", id: "p1" } as Resource;
  return {
    resourceType: "Bundle",
    id: "b",
    type: "transaction",
    entry: [org, obs, prac].map((resource) => ({ fullUrl: `http://x/${resource.resourceType}/${resource.id}`, resource, request: { method: "PUT", url: `${resource.resourceType}/${resource.id}` } })),
  };
}

const refs = (b: Resource) => JSON.stringify(b);
type Entry2 = { fullUrl: string; resource: Resource; request: object };
const duplicate412 = () =>
  new Response(JSON.stringify({ issue: [{ diagnostics: "HAPI-2840: Can not create resource duplicating existing resource: Organization/org-old" }] }), { status: 412 });
const created = () => new Response(JSON.stringify({ entry: [{ response: { location: "Observation/obs-1/_history/1" } }] }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

const existingOrg = { resourceType: "Organization", id: "org-old", name: "Labor Kanalstraße", meta: { versionId: "1" } } as Resource;

describe("reuseExisting", () => {
  it("drops our copy and points references at the existing resource", () => {
    const fixed = reuseExisting(bundle(), existingOrg);
    expect((fixed.entry as unknown[]).length).toBe(2);
    expect(refs(fixed)).not.toContain("org-new");
    expect(refs(fixed)).toContain('"Organization/org-old"');
    expect(refs(fixed)).toContain('"Practitioner/p1"');
  });
  it("picks the copy with the same content when there are several of that type", () => {
    const two = bundle();
    (two.entry as Entry2[]).push({ fullUrl: "x", resource: { resourceType: "Practitioner", id: "p-author", name: [{ family: "Brandl", given: ["Eva"] }] } as Resource, request: {} });
    (two.entry as Entry2[]).push({ fullUrl: "y", resource: { resourceType: "Practitioner", id: "p-other", name: [{ family: "Kern" }] } as Resource, request: {} });
    const obs = (two.entry as Entry2[]).find((e) => e.resource.resourceType === "Observation")!.resource as unknown as { performer: { reference: string }[] };
    obs.performer.push({ reference: "Practitioner/p-author" }); // the result points at the author, as in a real bundle
    const existing = { resourceType: "Practitioner", id: "p-old", name: [{ given: ["Eva"], family: "Brandl" }], meta: { versionId: "2" } } as Resource;
    const fixed = reuseExisting(two, existing);
    expect(refs(fixed)).toContain('"Practitioner/p-old"');
    expect(refs(fixed)).not.toContain("p-author");
    expect(refs(fixed)).toContain("p-other");
  });
  it("refuses when it cannot tell which resource is the duplicate", () => {
    const stranger = { resourceType: "Practitioner", id: "zzz", name: [{ family: "Nobody" }] } as Resource;
    expect(() => reuseExisting(bundle(), { ...stranger, id: "zzz" })).not.toThrow(); // only one candidate: p1
    const two = bundle();
    (two.entry as Entry2[]).push({ fullUrl: "x", resource: { resourceType: "Practitioner", id: "p2", name: [{ family: "Other" }] } as Resource, request: {} });
    expect(() => reuseExisting(two, stranger)).toThrow(/cannot tell/);
    expect(() => reuseExisting(bundle(), { resourceType: "Patient", id: "x" } as Resource)).toThrow(/cannot tell/);
  });
});

describe("fileBundle", () => {
  it("files straight away when the server accepts", async () => {
    const fetchMock = vi.fn(async () => created());
    vi.stubGlobal("fetch", fetchMock);
    expect(await fileBundle(env, bundle())).toEqual(["Observation/obs-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reuses the existing resource after a duplicate refusal and files on the second try", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(JSON.stringify(existingOrg), { status: 200 }); // lookup of the existing resource
      bodies.push(String(init?.body));
      return bodies.length === 1 ? duplicate412() : created();
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fileBundle(env, bundle())).toEqual(["Observation/obs-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(3); // refused, looked up, filed
    expect(bodies[0]).toContain("org-new");
    expect(bodies[1]).not.toContain("org-new");
    expect(bodies[1]).toContain("Organization/org-old");
  });
  it("does not retry other errors", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fileBundle(env, bundle())).rejects.toThrow(/FHIR server 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("gives up after a few rounds instead of looping", async () => {
    // every round names a new existing Organization, so the loop must stop by itself
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(JSON.stringify({ resourceType: "Organization", id: `org-${++n}`, name: "Labor Kanalstraße" }), { status: 200 });
      return new Response(JSON.stringify({ issue: [{ diagnostics: `duplicating existing resource: Organization/org-${n + 1}` }] }), { status: 412 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fileBundle(env, bundle())).rejects.toThrow();
    expect(fetchMock.mock.calls.length).toBeLessThan(20);
  });
});

describe("serverError", () => {
  it("shows the server's reason on one line, not the raw OperationOutcome", () => {
    const body = JSON.stringify({
      resourceType: "OperationOutcome",
      text: { status: "generated", div: "<div><h1>Operation Outcome</h1></div>" },
      issue: [{ severity: "error", diagnostics: "HAPI-2840: Can not create resource duplicating existing resource: Organization/org-1" }],
    });
    const message = serverError(412, body);
    expect(message).toBe("FHIR server 412: HAPI-2840: Can not create resource duplicating existing resource: Organization/org-1");
    expect(message).not.toContain("resourceType");
  });
  it("strips markup from a non-JSON error page", () => {
    expect(serverError(502, "<html><body><h1>Bad gateway</h1></body></html>")).toBe("FHIR server 502: Bad gateway");
  });
  it("copes with an empty body", () => {
    expect(serverError(500, "")).toBe("FHIR server 500:");
  });
});
