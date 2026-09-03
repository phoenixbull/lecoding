/**
 * IPC contract tests.
 *
 * Verifies that the named channels exposed across the preload bridge are
 * strictly typed and bidirectional. The preload bridge cannot escape this
 * schema; if a Renderer-side caller asks for a channel that is not listed,
 * the contract layer rejects the request before any IPC traffic happens.
 *
 * Security baseline (PRD § 10.1):
 * - preload only exposes a per-method, parameter-validated narrow interface
 * - ipcRenderer is never exposed directly
 * - arbitrary shell / fs / process calls are forbidden
 * - push channels are disjoint from invokable channels, so a Renderer can
 *   receive Run events but cannot call into the push plumbing
 */

import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  ipcRequestSchema,
  isKnownChannel,
  isKnownPushChannel,
  PUSH_CHANNELS,
  validateIpcRequest,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse
} from "../src/shared/ipc-contract.js";

describe("IPC contract", () => {
  it("exposes a closed set of channels (no string literals leak through)", () => {
    expect(IPC_CHANNELS).toEqual([
      "session.bootstrap",
      "session.openGitHubLogin",
      "session.status",
      "session.logout",
      "config.load",
      "devices.createCode",
      "devices.exchange",
      "devices.list",
      "devices.revoke",
      "runs.create",
      "runs.list",
      "runs.inspect",
      "runs.cancel",
      "runs.resolve",
      "runs.changes",
      "runs.artifact",
      "runs.approve",
      "runs.reject",
      "runs.editApprove",
      "runs.answer",
      "runs.steer",
      "runs.subscribe",
      "runs.unsubscribe",
      "policy.list",
      "policy.revoke"
    ]);
  });

  it("rejects unknown channel names with a typed error", () => {
    expect(isKnownChannel("shell.exec")).toBe(false);
  });

  it("accepts every documented channel", () => {
    for (const channel of IPC_CHANNELS) {
      expect(isKnownChannel(channel)).toBe(true);
    }
  });

  it("keeps push channels out of the invokable set", () => {
    for (const channel of PUSH_CHANNELS) {
      // A push channel is main-to-Renderer only; exposing it as an invoke
      // target would let the Renderer inject events into its own stream.
      expect(isKnownChannel(channel)).toBe(false);
      expect(isKnownPushChannel(channel)).toBe(true);
    }
    expect(isKnownPushChannel("runs.event")).toBe(true);
    expect(isKnownPushChannel("shell.exec")).toBe(false);
  });

  it("round-trips a bootstrap request through the schema", () => {
    const request: IpcRequest = {
      channel: "session.bootstrap",
      payload: { baseUrl: "https://agent.example", authToken: "x".repeat(64) }
    };
    const validated = validateIpcRequest(request);
    expect(validated.channel).toBe("session.bootstrap");
    expect(validated.payload).toEqual({
      baseUrl: "https://agent.example",
      authToken: "x".repeat(64)
    });
  });

  it("rejects payloads that violate the channel's parameter schema", () => {
    const bad = {
      channel: "runs.create" as const,
      // projectId must be a string; intentionally pass an empty string and a
      // missing input to trigger a validation failure.
      payload: { projectId: "", input: null }
    };
    expect(() => validateIpcRequest(bad as unknown as IpcRequest)).toThrow(/runs.create/);
  });

  it("accepts an empty object for channels that take no input", () => {
    for (const channel of ["config.load", "session.status"] as const) {
      expect(
        validateIpcRequest({ channel, payload: {} } as IpcRequest).channel
      ).toBe(channel);
    }
  });

  it("restricts approval scope to once, run, and project", () => {
    const base = { runId: "run-1", approvalId: "approval-1" };
    for (const scope of ["once", "run", "project"] as const) {
      expect(
        validateIpcRequest({
          channel: "runs.approve",
          payload: { ...base, scope }
        } as IpcRequest)
      ).toBeTruthy();
    }
    expect(() =>
      validateIpcRequest({
        channel: "runs.approve",
        payload: { ...base, scope: "forever" }
      } as unknown as IpcRequest)
    ).toThrow(/scope must be once\|run\|project/);
  });

  it("accepts a narrowed command capability and rejects a non-HTTPS egress", () => {
    expect(
      validateIpcRequest({
        channel: "runs.editApprove",
        payload: {
          runId: "run-1",
          approvalId: "approval-1",
          replacement: { type: "command_exec", argv: ["git", "status"] }
        }
      } as IpcRequest)
    ).toBeTruthy();
    expect(() =>
      validateIpcRequest({
        channel: "runs.editApprove",
        payload: {
          runId: "run-1",
          approvalId: "approval-1",
          // Only HTTPS narrowing is ever accepted; a plain-HTTP target is not
          // a narrowing, it is a different capability.
          replacement: { type: "network_egress", scheme: "http", domain: "example.com", port: 80 }
        }
      } as unknown as IpcRequest)
    ).toThrow(/network_egress/);
    expect(() =>
      validateIpcRequest({
        channel: "runs.editApprove",
        payload: {
          runId: "run-1",
          approvalId: "approval-1",
          replacement: { type: "shell_exec", script: "rm -rf /" }
        }
      } as unknown as IpcRequest)
    ).toThrow(/command_exec\|network_egress/);
  });

  it("bounds free-text commands at the bridge instead of the server", () => {
    expect(() =>
      validateIpcRequest({
        channel: "runs.steer",
        payload: { runId: "run-1", message: "x".repeat(4_001) }
      } as unknown as IpcRequest)
    ).toThrow(/at most 4000 characters/);
    expect(
      validateIpcRequest({
        channel: "runs.answer",
        payload: { runId: "run-1", requestId: "request-1", value: "x".repeat(4_000) }
      } as IpcRequest)
    ).toBeTruthy();
  });

  it("encodes error responses with a stable error code so the Renderer can branch", () => {
    const error: IpcResponse = {
      ok: false,
      code: "device_revoked",
      message: "device has been revoked"
    };
    expect(error.ok).toBe(false);
    if (error.ok === false) {
      expect(error.code).toBe("device_revoked");
    }
  });

  it("schema lookup falls back to a known sentinel for unknown channels", () => {
    const fake: IpcChannel = "shell.exec" as IpcChannel;
    expect(ipcRequestSchema(fake)).toBeNull();
  });

  it("registers a validator for every documented channel", () => {
    for (const channel of IPC_CHANNELS) {
      expect(ipcRequestSchema(channel)).not.toBeNull();
    }
  });
});
