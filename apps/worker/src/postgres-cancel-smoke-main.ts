import { runPostgresCancelSmoke } from "./postgres-cancel-smoke.js";

/** Stable failure output cannot reflect database credentials or payloads. */
function reportSmokeFailure(): void {
  process.exitCode = 1;
  console.error("LeCoding PostgreSQL cancel/reconnect smoke failed");
}

void runPostgresCancelSmoke({ environment: process.env })
  .then((report) => console.log(JSON.stringify(report, null, 2)))
  .catch(reportSmokeFailure);
