import { matchesName } from "./names";
import { splitName, type LabDoc, type LabRow, type ParsedDoc, type Person, type RehabDoc } from "./parse";
import type { VerifiedIdentity } from "./identity/types";

export type Resource = { resourceType: string; id: string } & Record<string, unknown>;

const UCUM = "http://unitsofmeasure.org";
export const IDENTITY_CHECK_SYSTEM = "https://aimh.example/fhir/CodeSystem/identity-check";

export interface BuildInput {
  requestId: string;
  /** Base URL of the FHIR server, used for entry fullUrl. */
  fhirBase: string;
  patientId: string;
  requester: { mxid: string; name?: string };
  docType: "lab-result" | "rehab-report";
  requestedAt: string;
  now: string;
  doc: ParsedDoc;
  markdown: string;
  sender: VerifiedIdentity;
  senderBpkHash?: string;
  verifiedAt: string;
}

export interface BuildResult {
  bundle: Resource;
  resources: Resource[];
  /** The clinical resources the Provenance points at. */
  targets: Resource[];
}

const ref = (r: Resource) => ({ reference: `${r.resourceType}/${r.id}` });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function practitioner(id: string, fullName: string, identifier?: { system: string; value: string }): Resource {
  const { prefix, given, family } = splitName(fullName);
  return {
    resourceType: "Practitioner",
    id,
    ...(identifier ? { identifier: [identifier] } : {}),
    active: true,
    name: [{ use: "official", family, ...(given.length ? { given } : {}), ...(prefix.length ? { prefix } : {}) }],
  };
}

function quantity(value: number, unit: string, comparator?: string) {
  return { value, unit: unit || "1", system: UCUM, code: unit ? unit.replace(/\^/g, "*").replace(/\s+/g, "") : "1", ...(comparator ? { comparator } : {}) };
}

function observation(row: LabRow, i: number, c: { id: string; input: BuildInput; doc: LabDoc; author: Resource; org: Resource; sr: Resource }): Resource {
  const { value, range, unit } = row;
  let interpretation: Record<string, unknown> | undefined;
  if (value.kind === "quantity" && !value.comparator && (range.low !== undefined || range.high !== undefined)) {
    const code = range.low !== undefined && value.value < range.low ? "L" : range.high !== undefined && value.value > range.high ? "H" : "N";
    interpretation = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code }] };
  }
  return {
    resourceType: "Observation",
    id: `obs-${c.id}-${i + 1}`,
    status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }],
    code: { coding: [{ system: "http://loinc.org", code: row.loinc }], text: row.test },
    subject: { reference: `Patient/${c.input.patientId}` },
    ...(c.doc.sampleTaken ? { effectiveDateTime: c.doc.sampleTaken } : {}),
    ...(c.doc.reported ? { issued: c.doc.reported } : {}),
    performer: [ref(c.author), ref(c.org)],
    basedOn: [ref(c.sr)],
    ...(value.kind === "quantity" ? { valueQuantity: quantity(value.value, unit, value.comparator) } : { valueString: value.text }),
    ...(interpretation ? { interpretation: [interpretation] } : {}),
    ...(range.low !== undefined || range.high !== undefined || range.text
      ? {
          referenceRange: [
            {
              ...(range.low !== undefined ? { low: quantity(range.low, unit) } : {}),
              ...(range.high !== undefined ? { high: quantity(range.high, unit) } : {}),
              text: range.text,
            },
          ],
        }
      : {}),
  };
}

function utf8ToBase64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Turn the parsed answer into FHIR R4: clinical resources plus one Provenance that records who sent it
 * and how their identity was checked. Ids derive from the request id, so filing twice overwrites.
 */
export function buildBundle(input: BuildInput): BuildResult {
  const { requestId: id, doc, sender } = input;
  const orgName = doc.kind === "rehab-report" ? doc.writtenBy.organization ?? doc.organization : doc.organization;

  const org: Resource = { resourceType: "Organization", id: `org-${id}`, active: true, name: orgName ?? "Unknown organisation" };
  const requesterPrac = practitioner(`practitioner-${slug(input.requester.mxid)}`, input.requester.name ?? input.requester.mxid, {
    system: "urn:matrix:user-id",
    value: input.requester.mxid,
  });

  const senderName = `${sender.givenName} ${sender.familyName}`;
  const senderPrac = practitioner(
    `practitioner-${input.senderBpkHash ?? `${id}-sender`}`,
    senderName,
    input.senderBpkHash ? { system: "https://aimh.example/id/bpk-sha256-prefix", value: input.senderBpkHash } : undefined,
  );

  const author: Person = doc.kind === "lab-result" ? doc.validatedBy : doc.writtenBy;
  const authorIsSender = matchesName(author.name, sender.givenName, sender.familyName);
  const authorPrac = authorIsSender ? senderPrac : practitioner(`practitioner-${id}-author`, author.name);

  const sr: Resource = {
    resourceType: "ServiceRequest",
    id: `sr-${id}`,
    status: "completed",
    intent: "order",
    code: { text: input.docType === "lab-result" ? "Laboratory result request" : "Rehabilitation discharge report request" },
    subject: { reference: `Patient/${input.patientId}` },
    authoredOn: input.requestedAt,
    requester: ref(requesterPrac),
    performer: [ref(org)],
  };

  const targets: Resource[] = [];
  const extra: Resource[] = [];
  if (doc.kind === "lab-result") {
    const obs = doc.rows.map((row, i) => observation(row, i, { id, input, doc, author: authorPrac, org, sr }));
    const report: Resource = {
      resourceType: "DiagnosticReport",
      id: `report-${id}`,
      status: "final",
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "LAB" }] }],
      code: { text: "Laboratory report" },
      subject: { reference: `Patient/${input.patientId}` },
      ...(doc.sampleTaken ? { effectiveDateTime: doc.sampleTaken } : {}),
      ...(doc.reported ? { issued: doc.reported } : {}),
      performer: [ref(org)],
      resultsInterpreter: [ref(authorPrac)],
      basedOn: [ref(sr)],
      result: obs.map(ref),
      ...(doc.conclusion ? { conclusion: doc.conclusion } : {}),
    };
    targets.push(...obs, report);
  } else {
    targets.push(documentReference(id, input, doc, authorPrac, org, sr));
  }

  const agents: Record<string, unknown>[] = [
    {
      type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type", code: "enterer" }] },
      who: ref(senderPrac),
      onBehalfOf: ref(org),
      // How the sender's identity was checked: method and eIDAS level as a code, time of the check in the text.
      role: [
        {
          coding: [{ system: IDENTITY_CHECK_SYSTEM, code: `${sender.method}-${sender.loa}` }],
          text: `Identity verified with ${sender.method} (level ${sender.loa}) at ${input.verifiedAt}; name matched the person the request was addressed to`,
        },
      ],
    },
  ];
  if (!authorIsSender) {
    agents.unshift({
      type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type", code: "author" }] },
      who: ref(authorPrac),
      onBehalfOf: ref(org),
    });
  }

  const provenance: Resource = {
    resourceType: "Provenance",
    id: `prov-${id}`,
    target: targets.map(ref),
    recorded: input.now,
    activity: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "CREATE" }] },
    agent: agents,
  };

  const resources = [org, requesterPrac, ...(authorIsSender ? [] : [authorPrac]), senderPrac, sr, ...targets, ...extra, provenance];
  for (const r of resources) addNarrative(r);
  const bundle: Resource = {
    resourceType: "Bundle",
    id: `bundle-${id}`,
    type: "transaction",
    entry: resources.map((resource) => ({
      fullUrl: `${input.fhirBase}/${resource.resourceType}/${resource.id}`,
      resource,
      request: { method: "PUT", url: `${resource.resourceType}/${resource.id}` },
    })),
  };
  return { bundle, resources, targets };
}

function documentReference(id: string, input: BuildInput, doc: RehabDoc, author: Resource, org: Resource, sr: Resource): Resource {
  return {
    resourceType: "DocumentReference",
    id: `docref-${id}`,
    status: "current",
    docStatus: "final",
    type: { coding: [{ system: "http://loinc.org", code: "18842-5" }], text: "Discharge summary" },
    category: [{ text: "Rehabilitation discharge report" }],
    subject: { reference: `Patient/${input.patientId}` },
    date: input.now,
    author: [ref(author)],
    custodian: ref(org),
    description: doc.reason ?? "Rehabilitation discharge report",
    content: [
      {
        attachment: {
          contentType: "text/markdown",
          language: "en",
          data: utf8ToBase64(input.markdown),
          title: doc.title ?? "Rehabilitation discharge report",
          creation: input.now,
        },
      },
    ],
    context: { period: { start: doc.stay.start, end: doc.stay.end }, related: [ref(sr)] },
  };
}

const xml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** One human-readable line per resource, so the record reads without a FHIR viewer. */
function addNarrative(r: Resource): void {
  const g = r as Record<string, any>;
  const name = (n: any) => [...(n?.prefix ?? []), ...(n?.given ?? []), n?.family].filter(Boolean).join(" ");
  const text: Record<string, () => string> = {
    Organization: () => g.name,
    Practitioner: () => name(g.name?.[0]),
    ServiceRequest: () => `${g.code?.text}, requested ${g.authoredOn}`,
    Observation: () =>
      `${g.code?.text}: ${g.valueQuantity ? `${g.valueQuantity.comparator ?? ""}${g.valueQuantity.value} ${g.valueQuantity.unit === "1" ? "" : g.valueQuantity.unit}` : g.valueString}`,
    DiagnosticReport: () => `${g.code?.text}, ${g.result?.length ?? 0} results${g.conclusion ? `. ${g.conclusion}` : ""}`,
    DocumentReference: () => `${g.content?.[0]?.attachment?.title ?? "Document"}, ${g.context?.period?.start} to ${g.context?.period?.end}`,
    Provenance: () => `Recorded ${g.recorded}. ${g.agent?.map((a: any) => a.role?.[0]?.text ?? a.type?.coding?.[0]?.code).filter(Boolean).join("; ")}`,
  };
  const line = text[r.resourceType]?.();
  if (line) g.text = { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">${xml(line.trim())}</div>` };
}
