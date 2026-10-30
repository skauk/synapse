import { describe, expect, it } from "vitest";
import { matchesName } from "../src/names";

describe("matchesName", () => {
  it("ignores titles and case", () => {
    expect(matchesName("Dr. Eva Brandl", "Eva", "BRANDL")).toBe(true);
  });
  it("allows extra names on the eID", () => {
    expect(matchesName("Eva Brandl", "Eva Maria", "Brandl")).toBe(true);
  });
  it("folds diacritics and ß", () => {
    expect(matchesName("Stefan Kern", "Stéfan", "Kern")).toBe(true);
    expect(matchesName("Anna Strauß", "Anna", "Strauss")).toBe(true);
  });
  it("rejects a colleague", () => {
    expect(matchesName("Dr. Eva Brandl", "Karl", "Kollege")).toBe(false);
  });
  it("rejects same given name, other family name", () => {
    expect(matchesName("Dr. Eva Brandl", "Eva", "Bauer")).toBe(false);
  });
  it("requires the family name, not just any token", () => {
    expect(matchesName("Eva Brandl", "Brandl", "Eva")).toBe(false);
  });
  it("rejects empty input", () => {
    expect(matchesName("", "Eva", "Brandl")).toBe(false);
  });
});

import { pickClaim } from "../src/identity/oidc";

describe("pickClaim", () => {
  it("takes the first candidate that holds a string", () => {
    expect(pickClaim({ given_name: "Eva" }, ["urn:pvpgvat:oidc.given_name", "given_name"])).toBe("Eva");
    expect(pickClaim({ a: "x", b: "y" }, ["a", "b"])).toBe("x");
  });
  it("ignores empty and non-string values", () => {
    expect(pickClaim({ a: "", b: 3, c: ["Eva"] }, ["a", "b", "c"])).toBeUndefined();
  });
});

import { loaRank, normalizeLoa } from "../src/identity/loa";

describe("assurance level", () => {
  it("normalises eIDAS URIs", () => {
    expect(normalizeLoa("http://eidas.europa.eu/LoA/high")).toBe("high");
    expect(normalizeLoa("http://eidas.europa.eu/LoA/substantial")).toBe("substantial");
    expect(normalizeLoa("LOW")).toBe("low");
    expect(normalizeLoa(undefined)).toBe("unknown");
  });
  it("ranks levels and never lets an unknown one pass", () => {
    expect(loaRank("high")).toBeGreaterThan(loaRank("substantial"));
    expect(loaRank("substantial")).toBeGreaterThan(loaRank("low"));
    expect(loaRank("unknown")).toBe(0);
    expect(loaRank("urn:something:else")).toBeLessThan(loaRank("substantial"));
  });
});
