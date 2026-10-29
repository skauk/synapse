/** Parser for the Markdown answer format (lab report, rehab discharge report). Deterministic on purpose. */

export class ParseError extends Error {}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, januar: 1, jänner: 1, february: 2, feb: 2, februar: 2, march: 3, mar: 3, märz: 3, maerz: 3,
  april: 4, apr: 4, may: 5, mai: 5, june: 6, jun: 6, juni: 6, july: 7, jul: 7, juli: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, oktober: 10, okt: 10, november: 11, nov: 11,
  december: 12, dec: 12, dezember: 12, dez: 12,
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** "12 March 1961", "12.03.1961" or "1961-03-12" to "1961-03-12". Null if it is not a real date. */
export function parseDate(text: string): string | null {
  const s = text.trim().replace(/\.$/, "");
  let y: number, m: number, d: number;
  let hit: RegExpMatchArray | null;
  if ((hit = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [y, m, d] = [+hit[1]!, +hit[2]!, +hit[3]!];
  else if ((hit = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) [y, m, d] = [+hit[3]!, +hit[2]!, +hit[1]!];
  else if ((hit = s.match(/^(\d{1,2})\.?\s+([A-Za-zäöüÄÖÜ]+)\.?\s+(\d{4})$/))) {
    const month = MONTHS[hit[2]!.toLowerCase()];
    if (!month) return null;
    [y, m, d] = [+hit[3]!, month, +hit[1]!];
  } else return null;
  return validDate(y, m, d) ? `${pad(y, 4)}-${pad(m)}-${pad(d)}` : null;
}

/** UTC offset of Europe/Vienna on the given local date and time, e.g. "+02:00". */
function viennaOffset(date: string, hh: number, mm: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Vienna", timeZoneName: "longOffset" }).formatToParts(
    new Date(Date.UTC(y, m - 1, d, hh, mm)),
  );
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const hit = name.match(/GMT([+-]\d{2}:\d{2})/);
  return hit?.[1] ?? "+00:00";
}

/** "22 October 2026, 08:10" to an ISO dateTime with the Vienna offset. A date without time stays a date. */
export function parseDateTime(text: string): string | null {
  const hit = text.trim().match(/^(.*?)(?:,|\s+at\s+|\s+um\s+)\s*(\d{1,2}):(\d{2})$/);
  if (!hit) return parseDate(text);
  const date = parseDate(hit[1]!);
  const [hh, mm] = [+hit[2]!, +hit[3]!];
  if (!date || hh > 23 || mm > 59) return null;
  return `${date}T${pad(hh)}:${pad(mm)}:00${viennaOffset(date, hh, mm)}`;
}

/** "2 to 23 September 2026", "28 August to 23 September 2026" or two full dates. */
export function parseStay(text: string): { start: string; end: string } | null {
  const [left, right] = text.split(/\s+(?:to|bis|-|–)\s+/i);
  if (!left || !right) return null;
  const end = parseDate(right);
  if (!end) return null;
  const [ey, em] = end.split("-").map(Number) as [number, number];
  let start = parseDate(left);
  if (!start) {
    const day = left.match(/^(\d{1,2})\.?$/);
    const dayMonth = left.match(/^(\d{1,2})\.?\s+([A-Za-zäöüÄÖÜ]+)$/);
    if (day) start = `${pad(ey, 4)}-${pad(em)}-${pad(+day[1]!)}`;
    else if (dayMonth) start = parseDate(`${dayMonth[1]} ${dayMonth[2]} ${ey}`);
  }
  return start && start <= end ? { start, end } : null;
}

export interface Person {
  name: string;
  role?: string;
  organization?: string;
}

const TITLE = /^(?:(?:dr|prof|mag|dipl|ing|dkfm|msc|bsc|ma|ba|phd|mba|med|univ)\.?-?)+$/i;

/** Split a name into titles, given names and family name for a FHIR HumanName. */
export function splitName(full: string): { prefix: string[]; given: string[]; family: string } {
  const words = full.trim().split(/\s+/).filter(Boolean);
  const prefix: string[] = [];
  while (words.length > 1 && TITLE.test(words[0]!)) prefix.push(words.shift()!);
  const family = words.pop() ?? "";
  return { prefix, given: words, family };
}

function person(text: string): Person {
  const [name = "", role, organization] = text.split(",").map((s) => s.trim());
  return { name, ...(role ? { role } : {}), ...(organization ? { organization } : {}) };
}

export interface RefRange {
  low?: number;
  high?: number;
  text: string;
}

function number_(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) ? n : null;
}

/** "0.8 to 1.2", "0,8-1,2", "< 5", ">= 3". */
export function parseRange(text: string): RefRange {
  const t = text.trim();
  const span = t.match(/^(-?[\d.,]+)\s*(?:to|bis|-|–)\s*(-?[\d.,]+)$/i);
  if (span) {
    const [low, high] = [number_(span[1]!), number_(span[2]!)];
    if (low !== null && high !== null) return { low, high, text: t };
  }
  const bound = t.match(/^(<=?|>=?|≤|≥)\s*(-?[\d.,]+)$/);
  if (bound) {
    const n = number_(bound[2]!);
    if (n !== null) return bound[1]!.startsWith("<") || bound[1] === "≤" ? { high: n, text: t } : { low: n, text: t };
  }
  return { text: t };
}

export interface LabRow {
  test: string;
  value: { kind: "quantity"; value: number; comparator?: "<" | "<=" | ">=" | ">" } | { kind: "string"; text: string };
  unit: string;
  range: RefRange;
  loinc: string;
}

interface Header {
  patient: { name: string; birthDate: string };
  title?: string;
  organization?: string;
}

export interface LabDoc extends Header {
  kind: "lab-result";
  requestedBy?: string;
  sampleTaken?: string;
  reported?: string;
  rows: LabRow[];
  conclusion?: string;
  validatedBy: Person;
}

export interface RehabDoc extends Header {
  kind: "rehab-report";
  stay: { start: string; end: string };
  reason?: string;
  sections: { title: string; body: string }[];
  writtenBy: Person;
  sentBy?: Person;
}

export type ParsedDoc = LabDoc | RehabDoc;

function fields(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const hit = line.match(/^([A-Za-zÄÖÜäöü ]{2,30}):\s*(.+)$/);
    if (hit && !out.has(hit[1]!.toLowerCase())) out.set(hit[1]!.toLowerCase(), hit[2]!.trim());
  }
  return out;
}

function parsePatient(line: string | undefined): { name: string; birthDate: string } {
  if (!line) throw new ParseError("The document has no “Patient:” line.");
  const [name, born] = line.split(/,\s*(?:born|geboren|geb\.)\s+/i);
  const birthDate = born ? parseDate(born) : null;
  if (!name?.trim() || !birthDate) throw new ParseError("Could not read patient name and birth date from the “Patient:” line.");
  return { name: name.trim(), birthDate };
}

function parseTable(lines: string[]): LabRow[] {
  const rows = lines.filter((l) => l.trim().startsWith("|")).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const header = rows.shift()?.map((c) => c.toLowerCase());
  if (!header) throw new ParseError("The lab table is missing.");
  const col = (needle: string) => header.findIndex((h) => h.includes(needle));
  const [iTest, iResult, iUnit, iRange, iLoinc] = [col("test"), col("result"), col("unit"), col("reference"), col("loinc")];
  if ([iTest, iResult, iUnit, iRange, iLoinc].includes(-1)) {
    throw new ParseError("The lab table needs the columns Test, Result, Unit, Reference range and LOINC code.");
  }
  const out: LabRow[] = [];
  for (const cells of rows) {
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const [test, result, unit, range, loinc] = [cells[iTest] ?? "", cells[iResult] ?? "", cells[iUnit] ?? "", cells[iRange] ?? "", cells[iLoinc] ?? ""];
    if (!test) throw new ParseError("A row in the lab table has no test name.");
    if (!/^\d{1,7}-\d$/.test(loinc)) throw new ParseError(`“${test}” has no valid LOINC code.`);
    if (!result) throw new ParseError(`“${test}” has no result.`);
    const num = result.match(/^(<=?|>=?)?\s*(-?\d+(?:[.,]\d+)?)$/);
    out.push({
      test,
      value: num
        ? { kind: "quantity", value: number_(num[2]!)!, ...(num[1] ? { comparator: num[1] as "<" | "<=" | ">=" | ">" } : {}) }
        : { kind: "string", text: result },
      unit,
      range: parseRange(range),
      loinc,
    });
  }
  if (!out.length) throw new ParseError("The lab table has no results.");
  return out;
}

export function parseAnswer(markdown: string): ParsedDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const f = fields(lines);
  const h1 = lines.find((l) => /^#\s+\S/.test(l))?.replace(/^#\s+/, "").trim();
  const header: Header = {
    patient: parsePatient(f.get("patient")),
    ...(h1 ? { title: h1, organization: h1.split(":")[0]!.trim() } : {}),
  };

  if (f.has("stay")) {
    const stay = parseStay(f.get("stay")!);
    if (!stay) throw new ParseError("Could not read the “Stay:” dates.");
    const writtenBy = f.get("written by");
    if (!writtenBy) throw new ParseError("The document has no “Written by:” line.");
    const sections: { title: string; body: string }[] = [];
    for (const line of lines) {
      const h2 = line.match(/^##\s+(.+)$/);
      if (h2) sections.push({ title: h2[1]!.trim(), body: "" });
      else if (sections.length && !/^(written|sent) by:/i.test(line)) sections[sections.length - 1]!.body += `${line}\n`;
    }
    for (const s of sections) s.body = s.body.trim();
    const sentBy = f.get("sent by");
    return {
      kind: "rehab-report",
      ...header,
      stay,
      ...(f.get("reason") ? { reason: f.get("reason")! } : {}),
      sections,
      writtenBy: person(writtenBy),
      ...(sentBy ? { sentBy: person(sentBy) } : {}),
    };
  }

  if (lines.some((l) => l.trim().startsWith("|"))) {
    const validatedBy = f.get("validated by");
    if (!validatedBy) throw new ParseError("The document has no “Validated by:” line.");
    const sample = f.get("sample taken");
    const reported = f.get("reported");
    const sampleTaken = sample ? parseDateTime(sample) : null;
    const reportedAt = reported ? parseDateTime(reported) : null;
    if (sample && !sampleTaken) throw new ParseError("Could not read “Sample taken:”.");
    if (reported && !reportedAt) throw new ParseError("Could not read “Reported:”.");
    const keyLine = /^(patient|requested by|sample taken|reported|validated by):/i;
    const notes = lines
      .filter((l) => l.trim() && !l.startsWith("#") && !l.trim().startsWith("|") && !keyLine.test(l))
      .join(" ")
      .trim();
    return {
      kind: "lab-result",
      ...header,
      ...(f.get("requested by") ? { requestedBy: f.get("requested by")! } : {}),
      ...(sampleTaken ? { sampleTaken } : {}),
      ...(reportedAt ? { reported: reportedAt } : {}),
      rows: parseTable(lines),
      ...(notes ? { conclusion: notes } : {}),
      validatedBy: person(validatedBy),
    };
  }

  throw new ParseError("This does not look like a lab report or a rehab discharge report.");
}
