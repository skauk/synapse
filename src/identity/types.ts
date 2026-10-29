/** What every identity provider must deliver, whatever the protocol behind it. */
export interface VerifiedIdentity {
  givenName: string;
  familyName: string;
  /** Persistent sector-specific identifier (ID Austria bPK). */
  bpk?: string;
  /** Assurance level as reported by the provider (eIDAS: low, substantial, high). */
  loa: string;
  /** Provider label for the audit trail and FHIR Provenance, e.g. "id-austria". */
  method: string;
}

export interface AuthContext {
  state: string;
  nonce: string;
  /** PKCE verifier. */
  verifier: string;
  redirectUri: string;
}

/** Replace the provider by changing IDP in the config, nothing else. */
export interface IdentityProvider {
  /** URL to send the browser to. */
  begin(ctx: AuthContext): Promise<string>;
  /** Handle the callback request and return the verified person. Throws on any failure. */
  complete(req: Request, ctx: AuthContext): Promise<VerifiedIdentity>;
}
