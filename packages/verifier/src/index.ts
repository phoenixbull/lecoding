import type {
  EnvironmentReport,
  RunId,
  StartRun,
  VerificationReport
} from "@lecoding/contracts";

export interface VerificationInput {
  runId: RunId;
  run: StartRun;
  environment: EnvironmentReport;
}

export interface Verifier {
  verify(input: VerificationInput): Promise<VerificationReport>;
}
