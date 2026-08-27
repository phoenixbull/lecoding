import { runPostgresSteeringSmoke } from "./postgres-steering-smoke.js";

/** Stable failure output cannot reflect database credentials or message data. */
function reportSmokeFailure(): void {
  process.exitCode = 1;
  console.error("LeCoding PostgreSQL steering smoke failed");
}

void runPostgresSteeringSmoke({ environment: process.env })
  .then((report) => console.log(JSON.stringify(report, null, 2)))
  .catch(reportSmokeFailure);
