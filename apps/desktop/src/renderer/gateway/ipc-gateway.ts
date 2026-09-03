import type { RunGateway } from "@lecoding/run-controller";
import type { LeCodingBridge } from "./bridge.js";

/**
 * Adapts the whitelisted IPC bridge to the shared console's `RunGateway` port.
 *
 * Every method maps one-to-one onto a documented channel, so the desktop
 * Renderer and the Web page run exactly the same controller behaviour with
 * only the transport swapped.
 */
export function createIpcRunGateway(bridge: LeCodingBridge): RunGateway {
  return {
    async getControlPlaneConfig() {
      return (await bridge["config.load"]({})) as Awaited<
        ReturnType<RunGateway["getControlPlaneConfig"]>
      >;
    },
    async logout() {
      await bridge["session.logout"]({});
    },
    async createRun(projectId, input) {
      return (await bridge["runs.create"]({ projectId, input })) as Awaited<
        ReturnType<RunGateway["createRun"]>
      >;
    },
    async inspectRun(runId) {
      return (await bridge["runs.inspect"]({ runId })) as Awaited<
        ReturnType<RunGateway["inspectRun"]>
      >;
    },
    async listRuns(projectId, limit) {
      return (await bridge["runs.list"]({
        projectId,
        ...(limit === undefined ? {} : { limit })
      })) as Awaited<ReturnType<RunGateway["listRuns"]>>;
    },
    async cancelRun(runId) {
      await bridge["runs.cancel"]({ runId });
    },
    async resolveRunResult(runId, outcome) {
      await bridge["runs.resolve"]({ runId, outcome });
    },
    async getRunChanges(runId) {
      return (await bridge["runs.changes"]({ runId })) as Awaited<
        ReturnType<RunGateway["getRunChanges"]>
      >;
    },
    async getRunArtifact(runId, artifactId) {
      return (await bridge["runs.artifact"]({ runId, artifactId })) as Awaited<
        ReturnType<RunGateway["getRunArtifact"]>
      >;
    },
    async approveRun(runId, approvalId, scope) {
      await bridge["runs.approve"]({ runId, approvalId, scope });
    },
    async rejectRun(runId, approvalId, scope) {
      await bridge["runs.reject"]({ runId, approvalId, scope });
    },
    async editAndApproveRun(runId, approvalId, replacement) {
      await bridge["runs.editApprove"]({ runId, approvalId, replacement });
    },
    async answerRun(runId, requestId, value) {
      await bridge["runs.answer"]({ runId, requestId, value });
    },
    async steerRun(runId, message) {
      await bridge["runs.steer"]({ runId, message });
    },
    async listProjectPolicyRules(projectId) {
      return (await bridge["policy.list"]({ projectId })) as Awaited<
        ReturnType<RunGateway["listProjectPolicyRules"]>
      >;
    },
    async revokeProjectPolicyRule(projectId, ruleId) {
      await bridge["policy.revoke"]({ projectId, ruleId });
    },
    async createDeviceCode(projectId) {
      return (await bridge["devices.createCode"]({ projectId })) as Awaited<
        ReturnType<RunGateway["createDeviceCode"]>
      >;
    },
    async exchangeDeviceCode(input) {
      await bridge["devices.exchange"]({
        code: input.code,
        deviceLabel: input.deviceLabel,
        platform: input.platform as "darwin" | "win32" | "linux",
        projectId: input.projectId
      });
    },
    async listDevices() {
      return (await bridge["devices.list"]({})) as Awaited<
        ReturnType<RunGateway["listDevices"]>
      >;
    },
    async revokeDevice(deviceId) {
      await bridge["devices.revoke"]({ deviceId });
    }
  };
}
