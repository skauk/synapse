const TITLES = new Set(["dr", "prof", "mag", "dipl", "ing", "msc", "bsc", "ma", "ba", "phd", "med", "univ", "dkfm", "mba"]);

function tokens(full: string): string[] {
  return full
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}-]+/gu, " ")
    .split(" ")
    .filter((t) => t && !TITLES.has(t));
}

/**
 * Does the eID identity belong to the person the doctor named?
 * Every name the doctor typed must appear in the eID name, and the last one
 * must be part of the family name. The eID may carry extra names.
 */
export function matchesName(expectedFull: string, givenName: string, familyName: string): boolean {
  const expected = tokens(expectedFull);
  const family = tokens(familyName);
  const all = new Set([...tokens(givenName), ...family]);
  const lastExpected = expected[expected.length - 1];
  if (!lastExpected || !family.includes(lastExpected)) return false;
  return expected.every((t) => all.has(t));
}

/** Same person on a document and in the request: all name parts equal, in any order, titles ignored. */
export function sameName(a: string, b: string): boolean {
  const [x, y] = [tokens(a).sort(), tokens(b).sort()];
  return x.length > 0 && x.length === y.length && x.every((t, i) => t === y[i]);
}
