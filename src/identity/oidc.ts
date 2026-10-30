import { createRemoteJWKSet, jwtVerify } from "jose";
import { normalizeLoa } from "./loa";
import type { AuthContext, IdentityProvider, VerifiedIdentity } from "./types";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** "post" sends the secret in the body, "basic" in an Authorization header. */
  clientAuth: "post" | "basic";
  /** Candidate claim names per field, first one present wins. ID Austria's names differ from plain OIDC. */
  claims: { givenName: string[]; familyName: string[]; bpk: string[]; loa: string[] };
  /** JSON for the OIDC `claims` request parameter. ID Austria only releases attributes that are requested this way. */
  claimsRequest?: string;
  method: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** First of the candidate claim names that holds a non-empty string, with the name that matched. */
export function findClaim(payload: Record<string, unknown>, names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const v = payload[name];
    if (typeof v === "string" && v) return { name, value: v };
  }
  return undefined;
}

export function pickClaim(payload: Record<string, unknown>, names: string[]): string | undefined {
  return findClaim(payload, names)?.value;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Authorization code flow with PKCE against any OIDC provider, including ID Austria. */
export class OidcProvider implements IdentityProvider {
  constructor(private cfg: OidcConfig) {}

  private async discover(): Promise<Discovery> {
    const res = await fetch(`${this.cfg.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    return res.json<Discovery>();
  }

  async begin(ctx: AuthContext): Promise<string> {
    const meta = await this.discover();
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: ctx.redirectUri,
      scope: this.cfg.scopes,
      state: ctx.state,
      nonce: ctx.nonce,
      code_challenge: await s256(ctx.verifier),
      code_challenge_method: "S256",
      ...(this.cfg.claimsRequest ? { claims: this.cfg.claimsRequest } : {}),
    }).toString();
    return url.toString();
  }

  async complete(req: Request, ctx: AuthContext): Promise<VerifiedIdentity> {
    const params = new URL(req.url).searchParams;
    const code = params.get("code");
    if (!code) throw new Error(`no code: ${params.get("error") ?? "unknown error"}`);

    const meta = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ctx.redirectUri,
      code_verifier: ctx.verifier,
      client_id: this.cfg.clientId,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.cfg.clientAuth === "basic") {
      headers.authorization = `Basic ${btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`)}`;
    } else {
      body.set("client_secret", this.cfg.clientSecret);
    }
    const tokenRes = await fetch(meta.token_endpoint, { method: "POST", headers, body });
    if (!tokenRes.ok) throw new Error(`token endpoint: ${tokenRes.status}`);
    const { id_token } = await tokenRes.json<{ id_token?: string }>();
    if (!id_token) throw new Error("no id_token");

    const { payload } = await jwtVerify(id_token, createRemoteJWKSet(new URL(meta.jwks_uri)), {
      issuer: meta.issuer,
      audience: this.cfg.clientId,
    });
    if (payload.nonce !== ctx.nonce) throw new Error("nonce mismatch");

    const given = findClaim(payload, this.cfg.claims.givenName);
    const family = findClaim(payload, this.cfg.claims.familyName);
    if (!given || !family) {
      // Names of the claims only, never their values: enough to fix the claim mapping.
      throw new Error(`name claims missing from id_token; it contains: ${Object.keys(payload).join(", ")}`);
    }
    const bpk = findClaim(payload, this.cfg.claims.bpk);
    const loa = findClaim(payload, this.cfg.claims.loa);
    return {
      givenName: given.value,
      familyName: family.value,
      bpk: bpk?.value,
      loa: normalizeLoa(loa?.value),
      method: this.cfg.method,
      claimsUsed: { givenName: given.name, familyName: family.name, ...(bpk ? { bpk: bpk.name } : {}), ...(loa ? { loa: loa.name } : {}) },
    };
  }
}
