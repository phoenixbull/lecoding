import { runPostgresWorkerSmoke } from "./postgres-smoke.js";

/** CLI failures remain stable so a malformed URI cannot be reflected into logs. */
function reportSmokeFailure(): void {
  process.exitCode = 1;
  console.error("LeCoding PostgreSQL Worker smoke failed");
}

void runPostgresWorkerSmoke({ environment: process.env })
  .then((report) => {
    // The report intentionally contains counts and fixed object names only.
    console.log(JSON.stringify(report, null, 2));
  })
  .catch(reportSmokeFailure);
