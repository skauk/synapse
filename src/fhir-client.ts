import type { Resource } from "./fhir";

/** POST a transaction Bundle. Returns the location of each created or updated resource. */
export async function fileBundle(env: Env, bundle: Resource): Promise<string[]> {
  const res = await fetch(env.FHIR_BASE_URL, {
    method: "POST",
    headers: { "content-type": "application/fhir+json", accept: "application/fhir+json" },
    body: JSON.stringify(bundle),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FHIR server ${res.status}: ${text.slice(0, 500)}`);
  const out = JSON.parse(text) as { entry?: { response?: { location?: string } }[] };
  return (out.entry ?? []).flatMap((e) => (e.response?.location ? [e.response.location.split("/_history")[0]!] : []));
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
