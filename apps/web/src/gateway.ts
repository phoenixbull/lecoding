import type { LeCodingClient } from "@lecoding/client-sdk";
import type { RunGateway } from "@lecoding/run-controller";

/**
 * Adapts the browser client SDK to the shared console's `RunGateway` port.
 *
 * The client is injected as a getter rather than a value because the page
 * replaces it whenever the session token changes; the controller itself lives
 * for the whole page lifetime and must never hold a stale session.
 */
export function createSdkRunGateway(getClient: () => LeCodingClient): RunGateway {
  return {
    getControlPlaneConfig: () => getClient().getControlPlaneConfig(),
    logout: () => getClient().logout(),
    createRun: (projectId, input) => getClient().createRun(projectId, input),
    inspectRun: (runId) => getClient().inspectRun(runId),
    listRuns: (projectId, limit) => getClient().listRuns(projectId, limit),
    cancelRun: (runId) => getClient().cancelRun(runId),
    resolveRunResult: (runId, outcome) => getClient().resolveRunResult(runId, outcome),
    getRunChanges: (runId) => getClient().getRunChanges(runId),
    getRunArtifact: (runId, artifactId) => getClient().getRunArtifact(runId, artifactId),
    approveRun: (runId, approvalId, scope) =>
      getClient().approveRun(runId, approvalId, scope),
    rejectRun: (runId, approvalId, scope) =>
      getClient().rejectRun(runId, approvalId, scope),
    editAndApproveRun: (runId, approvalId, replacement) =>
      getClient().editAndApproveRun(runId, approvalId, replacement),
    answerRun: (runId, requestId, value) => getClient().answerRun(runId, requestId, value),
    steerRun: (runId, message) => getClient().steerRun(runId, message),
    listProjectPolicyRules: (projectId) => getClient().listProjectPolicyRules(projectId),
    revokeProjectPolicyRule: (projectId, ruleId) =>
      getClient().revokeProjectPolicyRule(projectId, ruleId),
    createDeviceCode: (projectId) => getClient().createDeviceCode(projectId),
    exchangeDeviceCode: async (input) => {
      await getClient().exchangeDeviceCode(input);
    },
    listDevices: () => getClient().listDevices(),
    revokeDevice: (deviceId) => getClient().revokeDevice(deviceId)
  };
}
