import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBundle, type BuildInput } from "../src/fhir";
import { parseAnswer } from "../src/parse";

const doc = (name: string) => readFileSync(new URL(`../scenario/documents/${name}`, import.meta.url), "utf8");

function input(file: string, docType: BuildInput["docType"], sender: { given: string; family: string }): BuildInput {
  const markdown = doc(file);
  return {
    requestId: "11111111-2222-3333-4444-555555555555",
    fhirBase: "http://localhost:8080/fhir",
    patientId: "maria-beispiel",
    requester: { mxid: "@lena.hofer:klinikum.example", name: "Dr. Lena Hofer" },
    docType,
    requestedAt: "2026-10-29T10:00:00+01:00",
    now: "2026-10-29T10:05:00+01:00",
    doc: parseAnswer(markdown),
    markdown,
    sender: { givenName: sender.given, familyName: sender.family, loa: "high", method: "id-austria" },
    senderBpkHash: "a4d4273965275e7a",
    verifiedAt: "2026-10-29T10:04:00+01:00",
  };
}

const lab = buildBundle(input("lab-result-maria-beispiel.md", "lab-result", { given: "Eva", family: "Brandl" }));
const rehab = buildBundle(input("rehab-report-maria-beispiel.md", "rehab-report", { given: "Stefan", family: "Kern" }));

describe("lab result", () => {
  it("makes one Observation per row with LOINC codes and UCUM units", () => {
    const obs = lab.resources.filter((r) => r.resourceType === "Observation");
    expect(obs.map((o) => (o.code as any).coding[0].code)).toEqual(["6301-6", "14979-9", "777-3", "3255-7"]);
    expect((obs[0] as any).valueQuantity).toMatchObject({ value: 1, unit: "1", code: "1" });
    expect((obs[2] as any).valueQuantity).toMatchObject({ unit: "10^9/L", code: "10*9/L" });
    expect(obs.every((o) => (o as any).interpretation[0].coding[0].code === "N")).toBe(true);
  });
  it("points everything at the patient and the Provenance at every clinical resource", () => {
    const prov = lab.resources.find((r) => r.resourceType === "Provenance") as any;
    expect(prov.target).toHaveLength(5);
    for (const t of lab.targets) expect((t as any).subject.reference).toBe("Patient/maria-beispiel");
  });
  it("records one agent when author and sender are the same person", () => {
    const prov = lab.resources.find((r) => r.resourceType === "Provenance") as any;
    expect(prov.agent).toHaveLength(1);
    expect(prov.agent[0].role[0].coding[0].code).toBe("id-austria-high");
    expect(prov.agent[0].role[0].text).toContain("name matched");
  });
});

describe("rehab report", () => {
  it("attaches the text and keeps author and sender apart", () => {
    const ref = rehab.resources.find((r) => r.resourceType === "DocumentReference") as any;
    expect(Buffer.from(ref.content[0].attachment.data, "base64").toString("utf8")).toContain("Rivaroxaban");
    expect(ref.context.period).toEqual({ start: "2026-09-02", end: "2026-09-23" });
    const prov = rehab.resources.find((r) => r.resourceType === "Provenance") as any;
    expect(prov.agent.map((a: any) => a.type.coding[0].code)).toEqual(["author", "enterer"]);
  });
});

// `FHIR_OUT=.cache/fhir npm test` writes the resources for the HL7 validator (scripts/validate-fhir.sh).
if (process.env.FHIR_OUT) {
  it("writes resources for the validator", () => {
    const dir = process.env.FHIR_OUT!;
    mkdirSync(dir, { recursive: true });
    for (const [name, built] of [["lab", lab], ["rehab", rehab]] as const) {
      for (const r of built.resources) writeFileSync(`${dir}/${name}-${r.resourceType}-${r.id}.json`, JSON.stringify(r, null, 2));
    }
    writeFileSync(`${dir}/patient.json`, readFileSync(new URL("../scenario/patient.json", import.meta.url)));
  });
}
