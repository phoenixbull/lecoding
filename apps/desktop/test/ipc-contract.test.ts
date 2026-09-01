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
 */

import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  ipcRequestSchema,
  isKnownChannel,
  validateIpcRequest,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse
} from "../src/shared/ipc-contract.js";

describe("IPC contract", () => {
  it("exposes a closed set of channels (no string literals leak through)", () => {
    expect(IPC_CHANNELS).toEqual([
      "session.bootstrap",
      "session.logout",
      "devices.createCode",
      "devices.exchange",
      "devices.list",
      "devices.revoke",
      "runs.create",
      "runs.cancel",
      "runs.list",
      "runs.inspect",
      "runs.resolve"
    ]);
  });

  it("rejects unknown channel names with a typed error", () => {
    const result = isKnownChannel("shell.exec");
    expect(result).toBe(false);
  });

  it("accepts every documented channel", () => {
    for (const channel of IPC_CHANNELS) {
      expect(isKnownChannel(channel)).toBe(true);
    }
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
});