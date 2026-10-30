import type { Resource } from "./fhir";

type Entry = { resource: Resource };

/** The content of a resource without what the server or our ids add, in a stable key order, for comparing. */
function content(r: Record<string, unknown>): string {
  const { id: _id, meta: _meta, text: _text, ...rest } = r;
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(rest));
}

/**
 * The server named an existing resource that one of ours duplicates (a uniqueness rule on a shared server).
 * Drop our copy and point everything at the existing one. Our copy is the only resource of that type, or the one
 * whose content equals the existing resource's. Throws when that is unclear.
 */
export function reuseExisting(bundle: Resource, existing: Resource): Resource {
  const type = existing.resourceType;
  const entries = (bundle.entry ?? []) as Entry[];
  const ofType = entries.filter((e) => e.resource.resourceType === type && e.resource.id !== existing.id);
  const same = ofType.filter((e) => content(e.resource) === content(existing));
  const ours = ofType.length === 1 ? ofType : same;
  if (ours.length !== 1) throw new Error(`cannot tell which ${type} duplicates ${type}/${existing.id}`);
  const oldRef = JSON.stringify(`${type}/${ours[0]!.resource.id}`);
  const newRef = JSON.stringify(`${type}/${existing.id}`);
  const rest = entries.filter((e) => e !== ours[0]);
  return JSON.parse(JSON.stringify({ ...bundle, entry: rest }).replaceAll(oldRef, newRef)) as Resource;
}

/** One readable line from a FHIR OperationOutcome (its issue diagnostics), or the start of whatever came back. */
export function serverError(status: number, body: string): string {
  try {
    const issues = (JSON.parse(body) as { issue?: { diagnostics?: string; details?: { text?: string } }[] }).issue ?? [];
    const lines = issues.map((i) => i.diagnostics ?? i.details?.text).filter((l): l is string => !!l);
    if (lines.length) return `FHIR server ${status}: ${lines.join("; ").slice(0, 300)}`;
  } catch {
    // not JSON: fall through
  }
  return `FHIR server ${status}: ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`.trimEnd();
}

const DUPLICATE = /duplicating existing resource: ([A-Za-z]+)\/([A-Za-z0-9.-]+)/;

/**
 * POST a transaction Bundle. Returns the location of each created or updated resource.
 * A shared FHIR server may refuse a resource because an identical one exists (HTTP 412, "duplicating existing
 * resource"). We then reuse the existing resource and try again, a few times at most.
 */
export async function fileBundle(env: Env, bundle: Resource): Promise<string[]> {
  let current = bundle;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(env.FHIR_BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/fhir+json", accept: "application/fhir+json" },
      body: JSON.stringify(current),
    });
    const text = await res.text();
    if (res.ok) {
      const out = JSON.parse(text) as { entry?: { response?: { location?: string } }[] };
      return (out.entry ?? []).flatMap((e) => (e.response?.location ? [e.response.location.split("/_history")[0]!] : []));
    }
    const duplicate = res.status === 412 ? text.match(DUPLICATE) : null;
    if (!duplicate || attempt >= 5) throw new Error(serverError(res.status, text));
    const found = await fetch(`${env.FHIR_BASE_URL}/${duplicate[1]}/${duplicate[2]}`, { headers: { accept: "application/fhir+json" } });
    if (!found.ok) throw new Error(serverError(res.status, text));
    current = reuseExisting(current, await found.json<Resource>());
  }
}

export interface PatientRef {
  id: string;
  name: string;
  birthDate: string;
}

/** Find the patient by FHIR id or by identifier (MRN). Name and birth date come from the record, not from the doctor's typing. */
export async function findPatient(env: Env, ref: string): Promise<PatientRef | null> {
  for (const query of [`Patient?_id=${encodeURIComponent(ref)}`, `Patient?identifier=${encodeURIComponent(ref)}`]) {
    const res = await fetch(`${env.FHIR_BASE_URL}/${query}`, { headers: { accept: "application/fhir+json" } });
    if (!res.ok) throw new Error(`FHIR server ${res.status} while looking up the patient`);
    const bundle = await res.json<{ entry?: { resource: any }[] }>();
    const p = bundle.entry?.[0]?.resource;
    const n = p?.name?.[0];
    if (p && n?.family && p.birthDate) {
      return { id: p.id, name: [...(n.given ?? []), n.family].join(" "), birthDate: p.birthDate };
    }
  }
  return null;
}
