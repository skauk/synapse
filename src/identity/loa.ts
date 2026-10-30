/** eIDAS levels of assurance, lowest to highest. */
const RANK: Record<string, number> = { low: 1, substantial: 2, high: 3 };

/** "http://eidas.europa.eu/LoA/high" and "high" both become "high". Anything else is kept as is. */
export function normalizeLoa(value: string | undefined): string {
  if (!value) return "unknown";
  const last = value.split("/").pop()?.toLowerCase() ?? "";
  return last in RANK ? last : value;
}

/** 0 for a level we do not recognise, so an unknown level never passes a minimum. */
export function loaRank(level: string): number {
  return RANK[level.toLowerCase()] ?? 0;
}
