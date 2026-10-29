# Track 2: Health Data Interoperability

Austrian doctors are piloting PGK, a closed document network built on Matrix. Patients, labs and rehab clinics outside the network are still reached by fax or unencrypted email and their results come back as scans that someone types in by hand.

## What to build

A service that lets a doctor in the network request a document from someone outside it and files the answer as FHIR R4.

1. Dr. Lena Hofer requests the document from her Matrix room, through a bot or a widget.
2. The outside person gets a link by email or SMS, proves who they are and answers in the browser. They need no account and install nothing. You can simulate an electronic ID such as ID Austria.
3. Your service turns the answer into FHIR resources plus a Provenance resource: who sent it, when and how their identity was checked.
4. It stores the resources on a FHIR server and tells Dr. Hofer in Matrix.

Also:

- Lab values become Observations with their LOINC codes. The rehab report can be a DocumentReference with the text attached.
- Write an audit entry at each of the six steps listed under Metrics.
- Catch misdeliveries, such as a request sent to the wrong address.
- Emails and SMS must not contain the patient's name, birth date or the type of document.
- You may use commercial products, FTAPI's included, as long as each one could be replaced by another.

You do not need your own Matrix app or end-to-end encryption. Element Web and an upload over HTTPS are enough.

## What you get

- `scenario/README.md`: the people, the two requests (lab result by email, rehab report by SMS) and suggested tools.
- `scenario/patient.json`: the patient, Maria Beispiel, as a FHIR Patient.
- `scenario/documents/`: the answers as Markdown, plus a lab result for a different patient.
- `scenario/misdelivery.md`: three misdelivery tests.

There is no starter code.

## Metrics

Measure these on the scenario. The jury also tests with other outside people and documents in the same Markdown format, some of them for the wrong patient.

| Metric | How to measure | Target |
|---|---|---|
| FHIR validation | Errors from the HL7 validator on every resource you file (command in `scenario/README.md`) | 0 |
| Effort for the outside person | Someone new answers request 1. Count the installs and accounts they need and the time from opening the email to sending | 0, 0, under 2 min |
| Misdeliveries caught | The three tests in `scenario/misdelivery.md`, run on request 1 | 3 of 3 |
| Audit coverage | Steps logged with who, what and when: request sent, link opened, identity checked, answer sent, answer filed, misdelivery caught | 6 of 6 |

## Your design

Answer these in your repository README:

1. How does an outside person prove who they are if they are in no directory?
2. Which identity check do you require for each type of document and why?
3. Which FHIR resources do you create and how do they reference each other and the patient?
4. How do you notice a misdelivery?
5. Where does your service run: at the clinic, at the outside organisation or at a third party?

## Rules

Use only synthetic data.

## Judging

| Criterion | Weight | Question |
|---|---|---|
| Clinical approach and impact | 33.3% | Would a lab, rehab clinic or patient answer this way? Could a clinic run it? |
| Technical quality and AI | 33.3% | Is the FHIR data valid and useful? Is the identity check strong enough without burdening the outside person? If you use AI, is its output correct? |
| Execution and prototype | 33.3% | Does the whole flow work, on this scenario and on new documents? |

The jury scores each criterion from 1 to 10 and takes your metric results into account.

## Submission

1. A video of up to 2 minutes showing your demo. Say what works and what does not.
2. A link to your public repository with instructions to run it and your design answers. Its README has to explain your technical architecture: which components you built, how they work together and which models or services you use.
3. Your metric results on this scenario.
