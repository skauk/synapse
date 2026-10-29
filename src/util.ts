export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of secrets of any length. */
export async function secretEquals(given: string, expected: string): Promise<boolean> {
  const a = new TextEncoder().encode(await sha256Hex(given));
  const b = new TextEncoder().encode(await sha256Hex(expected));
  return crypto.subtle.timingSafeEqual(a, b);
}

export function requestStub(env: Env, id: string) {
  return env.REQUEST.get(env.REQUEST.idFromName(id));
}
