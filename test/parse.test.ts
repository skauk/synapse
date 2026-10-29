import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError, parseAnswer, parseDate, parseDateTime, parseRange, parseStay, splitName } from "../src/parse";

const doc = (name: string) => readFileSync(new URL(`../scenario/documents/${name}`, import.meta.url), "utf8");

describe("scenario documents", () => {
  it("parses the lab result", () => {
    const d = parseAnswer(doc("lab-result-maria-beispiel.md"));
    if (d.kind !== "lab-result") throw new Error("wrong kind");
    expect(d.patient).toEqual({ name: "Maria Beispiel", birthDate: "1961-03-12" });
    expect(d.organization).toBe("Labor Kanalstraße");
    expect(d.sampleTaken).toBe("2026-10-22T08:10:00+02:00");
    expect(d.reported).toBe("2026-10-22T11:40:00+02:00");
    expect(d.rows.map((r) => r.loinc)).toEqual(["6301-6", "14979-9", "777-3", "3255-7"]);
    expect(d.rows[0]).toMatchObject({ unit: "", value: { kind: "quantity", value: 1 }, range: { low: 0.8, high: 1.2 } });
    expect(d.rows[2]).toMatchObject({ unit: "10^9/L" });
    expect(d.conclusion).toBe("All values are within the reference range.");
    expect(d.validatedBy).toEqual({ name: "Dr. Eva Brandl", role: "lab physician" });
  });
  it("parses the other patient's lab result", () => {
    const d = parseAnswer(doc("lab-result-max-beispiel.md"));
    expect(d.patient).toEqual({ name: "Max Beispiel", birthDate: "1960-01-01" });
  });
  it("parses the rehab report", () => {
    const d = parseAnswer(doc("rehab-report-maria-beispiel.md"));
    if (d.kind !== "rehab-report") throw new Error("wrong kind");
    expect(d.stay).toEqual({ start: "2026-09-02", end: "2026-09-23" });
    expect(d.sections.map((s) => s.title)).toEqual(["Course", "Medication at discharge", "Recommendations"]);
    expect(d.writtenBy).toEqual({ name: "Dr. Johanna Leitner", role: "medical director", organization: "Reha Waldblick" });
    expect(d.sentBy).toEqual({ name: "Stefan Kern", role: "discharge management" });
  });
});

describe("rejects what it cannot read", () => {
  it("no patient line", () => expect(() => parseAnswer("hello")).toThrow(ParseError));
  it("bad birth date", () => expect(() => parseAnswer("Patient: A B, born 31 February 1960")).toThrow(ParseError));
  it("lab row without LOINC", () => {
    const md = "Patient: A B, born 1 January 1960\n| Test | Result | Unit | Reference range | LOINC code |\n|---|---|---|---|---|\n| X | 1 | g | 0 to 2 | |\nValidated by: Dr. C D";
    expect(() => parseAnswer(md)).toThrow(/LOINC/);
  });
});

describe("helpers", () => {
  it("dates", () => {
    expect(parseDate("1 January 1960")).toBe("1960-01-01");
    expect(parseDate("12.03.1961")).toBe("1961-03-12");
    expect(parseDate("5. März 2020")).toBe("2020-03-05");
    expect(parseDate("30 February 2020")).toBeNull();
  });
  it("uses summer and winter time", () => {
    expect(parseDateTime("22 October 2026, 08:10")).toBe("2026-10-22T08:10:00+02:00");
    expect(parseDateTime("27 October 2026, 08:10")).toBe("2026-10-27T08:10:00+01:00");
  });
  it("stays", () => {
    expect(parseStay("28 August to 23 September 2026")).toEqual({ start: "2026-08-28", end: "2026-09-23" });
    expect(parseStay("23 to 2 September 2026")).toBeNull();
  });
  it("ranges", () => {
    expect(parseRange("< 5")).toEqual({ high: 5, text: "< 5" });
    expect(parseRange("0,8 – 1,2")).toMatchObject({ low: 0.8, high: 1.2 });
  });
  it("names", () => expect(splitName("Dr. Eva Maria Brandl")).toEqual({ prefix: ["Dr."], given: ["Eva", "Maria"], family: "Brandl" }));
});
