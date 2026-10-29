// Load the scenario patient into the FHIR server so filed resources can reference Patient/maria-beispiel.
import { readFileSync } from "node:fs";
const base = process.env.FHIR_BASE_URL ?? "http://localhost:8080/fhir";
const patient = JSON.parse(readFileSync(new URL("../scenario/patient.json", import.meta.url), "utf8"));
// On the shared public test server pass your own id (PATIENT_ID=...) so your data does not mix with other teams'.
if (process.env.PATIENT_ID) patient.id = process.env.PATIENT_ID;
const res = await fetch(`${base}/Patient/${patient.id}`, {
  method: "PUT",
  headers: { "content-type": "application/fhir+json" },
  body: JSON.stringify(patient),
});
console.log(res.status, res.ok ? "patient loaded" : await res.text());
process.exit(res.ok ? 0 : 1);
