# External document requests for the PGK network (Track 2: Health Data Interoperability)

A doctor in the closed network asks someone outside it for a document. The outside person gets a generic link by email or SMS, proves who they are with an electronic ID, answers in the browser, and the service files the answer as validated FHIR R4 and tells the doctor in Matrix. No account, no install for the outside person.

The original brief is in [`docs/challenge-brief.md`](docs/challenge-brief.md); the synthetic scenario is in [`scenario/`](scenario/).

## What works, what is simulated

| Part | Status |
|---|---|
| Request from a Matrix room (`!request …`), generic email/SMS, link | Works (email and SMS are simulated: a page in the app) |
| Identity check with an eID, name matched to the named person | Works with a **mock ID Austria**. The real ID Austria adapter is written but **not yet tested**: the service provider registration is awaiting accreditation (see below) |
| Answer by upload or paste of the Markdown | Works |
| Parsing, FHIR mapping, filing to a FHIR server, HL7 validator | Works, 0 validator errors |
| Misdelivery: wrong address, forwarded request, wrong patient, wrong document type | Works (tested with the mock IdP) |
| Audit log of all six steps, hash-chained | Works |
| Notification to Dr. Hofer in Matrix | Works locally (Synapse + Element in Docker) |

Not built: a warning for look-alike domains at request time, a qualified electronic signature on the answer, enforcement of a minimum assurance level, retry when the FHIR server is down, Matrix on the deployed Worker (it cannot reach a Synapse on a laptop), a typed-in form (we take the Markdown file or pasted text, the patient identity comes from its header), mapping of the rehab medication list to FHIR (it is attached as text).

## Architecture

```
 Element Web ──▶ Synapse ──(app service push)──▶ ┌────────────────────────── Cloudflare Worker ──────────────────────────┐
  Dr. Hofer         ▲                             │ Hono routes: Matrix bot · request API · outsider portal · audit API  │
                    │ bot replies                  │ Durable Object per request: state, one-time link token, sessions     │
                    └──────────────────────────────│ D1: audit (hash chain), simulated outbox, Matrix event dedupe        │
                                                   │ parse.ts → fhir.ts (builder) → fhir-client.ts                        │
 Outside person ◀── email/SMS (link only) ─────────│ identity/: IdentityProvider = OIDC (ID Austria) | mock               │
   browser ───────▶ link → eID login → answer ─────└───────────────┬──────────────────────────────────────────────────────┘
                                                                   ▼
                                                      HAPI FHIR server (R4)
```

| Component | Role | Built or used | Replaceable by |
|---|---|---|---|
| Worker (`src/`) | All service logic | Built (TypeScript, Hono, `jose`) | Any runtime for Workers-style code |
| Durable Object `RequestDO` | Per-request state, link token (stored hashed), attempt counter and lockout, one answer per request | Built | A database row with a lock |
| D1 | Audit log, outbox, event dedupe | Used | Any SQL database |
| Identity provider | Proves who the outside person is | `OidcProvider` (ID Austria) and `MockProvider` behind one interface | Any OIDC or eIDAS provider; set `IDP` and the OIDC settings |
| Matrix | Closed network | Synapse + Element Web (Docker), bot as an application service | Any Matrix server |
| FHIR server | Storage | HAPI (Docker) or the public HAPI test server | Any FHIR R4 server |
| Mail and SMS | Delivery of the generic link | Simulated in D1 (`/outbox`) | Cloudflare Email Sending, an SMS gateway: one function in `create-request.ts` |
| HL7 validator | Quality gate | `validator_cli.jar`, run by `scripts/validate-fhir.sh` | – |

**No AI model is used.** Parsing is deterministic, so the patient check, the FHIR mapping and the identity decision never depend on model output. That was a deliberate choice for the safety-relevant steps.

## Flow

1. Dr. Hofer writes `!request lab "Dr. Eva Brandl" eva.brandl@labor-kanal.example maria-beispiel` in her room. Only members listed in `MATRIX_MEMBERS` may. The patient is looked up on the FHIR server, so name and birth date come from the record.
2. The service stores the request and "sends" a message with a link. The message names the sender and organisation only: no patient name, birth date or document type.
3. The link page shows nothing about the request. The person identifies with their eID.
4. The eID name must match the person named in the request. Five failures lock the request.
5. Only now does the page show which patient and document are requested. The person uploads or pastes the Markdown.
6. The service checks that the document is the requested kind and is about the right patient (name and birth date), builds the FHIR resources and files them in one transaction.
7. Dr. Hofer is told in her room, including how the identity was checked. Every step is written to the audit log.

## Design answers

**1. How does an outside person prove who they are if they are in no directory?**
With an electronic ID that does not depend on any directory of ours: ID Austria, which is an eIDAS-notified scheme. The doctor only knows a name, a role and a contact, so the check is that the verified eID name matches the named person. The email or SMS link is only a delivery path, and holding it proves nothing: a wrong or forwarded link is rejected because the eID name does not match. The link token is random, stored hashed and expires after 7 days.

**2. Which identity check do you require for each document type, and why?**
Both the lab result and the rehab discharge report require the same check: eID login plus name match. Lab values drive a clinical decision and a wrong value can cause harm, and the discharge report contains medication, so a channel-only check (a code sent to a phone) is not enough for either: SIM swaps, shared inboxes and forwarding break it. We did not set a weaker tier for the rehab report. Open points: the assurance level is recorded in the Provenance but not yet enforced (the registered service provider does not request ID Austria's level attribute yet), and a qualified electronic signature over the answer would add non-repudiation and is not built. For the rehab report the sender (Stefan Kern, verified) is not the author (Dr. Leitner, as written in the document), and the Provenance records both.

**3. Which FHIR resources do you create and how do they reference each other and the patient?**
All clinical resources point at the existing `Patient` (`subject`). A `ServiceRequest` (the doctor's request) is referenced by the results (`basedOn`, or `context.related` for the document).
- Lab: one `Observation` per row (LOINC code, UCUM value and unit, reference range, interpretation, `effectiveDateTime` from the sample time, `issued` from the report time) and a `DiagnosticReport` whose `result` lists them.
- Rehab: a `DocumentReference` (LOINC 18842-5 Discharge summary) with the Markdown attached as `text/markdown`, the stay as `context.period` and the author and custodian.
- Supporting: `Practitioner` (requesting doctor, verified sender, author if different), `Organization`.
- One `Provenance` whose `target` is every clinical resource. Its agents are the author and the sender (type `enterer`). The sender's agent has a coded `role` that records the method and level of the identity check (e.g. `id-austria-high`) and the text with the time of the check. Times taken from the documents carry the Vienna offset.
- Ids derive from the request id, so filing the same answer twice overwrites instead of duplicating.

**4. How do you notice a misdelivery?**
- **Wrong address (M1) and forwarded request (M2):** the eID name does not match the named person. Nothing about the request is shown, no answer is accepted, and the failed check is in the audit log with the name and a hash of the bPK of the person who tried.
- **Wrong patient (M3):** the document's patient name and birth date are compared with the request. A mismatch is not filed, Dr. Hofer is warned in her room and `misdelivery_caught` is logged. The warning names the mismatching fields but not the other patient's data.
- **Wrong document type:** a rehab report for a lab request is refused the same way.
- Not built: a warning at request time when the typed domain looks like a typo of a known one.

**5. Where does your service run?**
The prototype runs on Cloudflare Workers, which is a third party, with the FHIR server and Matrix local or at the clinic. That is a trade-off we accept for a demo only. The service keeps request metadata (including the patient name for the match) and the audit log, and the answer passes through it to the FHIR server without being stored. For real use we would run it at the clinic: the code uses only standard Workers APIs plus a Durable Object and a SQL database, so it can run on the open-source `workerd` runtime inside the clinic's own network, with only the portal reachable from outside. We would not run it at the outside organisation, which cannot be trusted to enforce the checks.

## Metrics on the scenario

| Metric | Result | How measured |
|---|---|---|
| FHIR validation | **0 errors** on all 18 resources (lab set, rehab set, patient), 3 warnings (2 about our own undefined code system, 1 about the organizers' `patient.json` having no narrative) | `scripts/validate-fhir.sh` (HL7 validator, R4) |
| Effort for the outside person | **0 installs, 0 accounts.** Time from opening the email to sending: not yet measured with a new person | To do with a stopwatch on a new person. Also depends on the real ID Austria login, which has not run yet |
| Misdeliveries caught | **3 of 3** with the mock IdP | `node test/e2e.mjs` and `node test/matrix-e2e.mjs` |
| Audit coverage | **6 of 6** steps, each with who, what and when; the hash chain verifies and a tampered or deleted entry is detected | `node test/e2e.mjs`, `GET /api/audit/verify` |

Last runs: 24 unit tests, 30 end-to-end checks (`test/e2e.mjs`) and 13 Matrix checks (`test/matrix-e2e.mjs`, six consecutive runs), all passing; the validator run exits 0. The end-to-end checks use the mock IdP, not the real ID Austria.

## Run it

Needs Node 22, Docker, Java (for the validator) and `curl`. Only synthetic data.

```bash
npm install
docker compose up -d hapi                  # FHIR server on :8080
node scripts/seed-patient.mjs              # loads scenario/patient.json
npm run db:local                           # local D1 migrations
./scripts/matrix-setup.sh                  # Synapse, Element, bot registration, Dr. Hofer's account and room
npm run dev                                # Worker on :8787, mock ID Austria, simulated mail/SMS
```

- Element: http://localhost:8081, log in as `@lena.hofer:klinikum.example` / `demo-only-lena` (homeserver `http://localhost:8008`), room "External requests", type `!help`.
- The bot's confirmation includes a demo link (mock mode only). Open it, pick "Log in as Eva Brandl" and upload `scenario/documents/lab-result-maria-beispiel.md`. Pick "Karl Kollege" to see the forwarded-request case, upload `lab-result-max-beispiel.md` to see the wrong-patient case.
- Simulated mail and SMS, and the messages to Dr. Hofer: http://localhost:8787/outbox
- Tests: `npm test` (unit), `node test/e2e.mjs`, `node test/matrix-e2e.mjs` (against the running stack), `./scripts/validate-fhir.sh` (downloads the HL7 validator on first run).
- `npm run typecheck`.

Local settings live in `.dev.vars` (gitignored; see `.dev.vars.example`) and override `wrangler.jsonc`, which is the deployed configuration. The mock IdP only runs when `BASE_URL` is `http://localhost…`.

## Real ID Austria

`src/identity/oidc.ts` is a generic OIDC client (authorization code, PKCE, JWKS verification). It is configured for the ID Austria reference environment (`https://idp.ref.id-austria.gv.at`; per its discovery document: scopes `openid profile`, `client_secret_post`, claims requested through the `claims` parameter and returned in the ID token). The service provider version is registered with the redirect URL `https://synapse.skauk.workers.dev/auth/callback` and is waiting for accreditation. Until it is approved, the IdP answers every client ID with "not registered" (`scripts/probe-idp.sh`), so the client ID and the claim names (`urn:pvpgvat:oidc.*` are unverified guesses) are not confirmed. The first real login will report the claim names it received.

## Layout

```
src/index.ts          routes: request API, outsider portal, audit API, Matrix app service, mock helpers
src/request-do.ts     per-request state (Durable Object)
src/identity/         IdentityProvider, OIDC (ID Austria), mock
src/parse.ts          Markdown → structured answer
src/fhir.ts           structured answer → FHIR bundle (pure, tested, validated)
src/fhir-client.ts    filing and patient lookup
src/matrix.ts         bot commands and application service
src/audit.ts          hash-chained audit log
migrations/           D1 schema
scripts/              Matrix setup, FHIR validation, IdP probe, patient seed
test/                 unit tests and end-to-end scripts
```
