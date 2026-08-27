import { runPostgresFailoverSmoke } from "./postgres-failover-smoke.js";

/** Fixed failure output prevents connection or provider settings entering logs. */
function reportSmokeFailure(): void {
  process.exitCode = 1;
  console.error("LeCoding PostgreSQL failover smoke failed");
}

void runPostgresFailoverSmoke({ environment: process.env })
  .then((report) => console.log(JSON.stringify(report, null, 2)))
  .catch(reportSmokeFailure);
