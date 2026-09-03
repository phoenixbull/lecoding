import {
  parseRunEvent,
  type CreateRunInput,
  type CreateRunResult,
  type ControlPlaneConfig,
  type EditedApprovalCapability,
  type ProjectId,
  type ProjectMembershipResult,
  type ProjectPolicyRuleResult,
  type ProjectRole,
  type RunEventV1,
  type RunChanges,
  type RunHistoryResult,
  type RunId,
  type RunOperationalMetrics,
  type RunView
} from "@lecoding/contracts";
import {
  createDeviceCredentialStore,
  type DeviceCredentialStore,
  type SecureStore
} from "@lecoding/secure-store";

/** Shared Web/PC client interface for versioned Run operations. */
export interface LeCodingClient {
  /** Returns the same-origin login entry without exposing provider configuration. */
  getGitHubLoginUrl(): string;
  /** Revokes the current bearer or HttpOnly cookie session. */
  logout(): Promise<void>;
  getControlPlaneConfig(): Promise<ControlPlaneConfig>;
  createRun(projectId: ProjectId, input: CreateRunInput): Promise<CreateRunResult>;
  inspectRun(runId: RunId): Promise<RunView>;
  listRuns(projectId: ProjectId, limit?: number): Promise<RunHistoryResult>;
  listProjectMemberships(projectId: ProjectId): Promise<ProjectMembershipResult>;
  setProjectMembership(
    projectId: ProjectId,
    userId: string,
    role: ProjectRole
  ): Promise<void>;
  removeProjectMembership(projectId: ProjectId, userId: string): Promise<void>;
  listProjectPolicyRules(projectId: ProjectId): Promise<ProjectPolicyRuleResult>;
  revokeProjectPolicyRule(projectId: ProjectId, ruleId: string): Promise<void>;
  getRunChanges(runId: RunId): Promise<RunChanges>;
  /** Loads content-free durations and outcome counters from durable Run events. */
  getRunMetrics(runId: RunId): Promise<RunOperationalMetrics>;
  /** Loads hash-verified, redacted command output through its owning Run scope. */
  getRunArtifact(runId: RunId, artifactId: string): Promise<string>;
  /** Keeps or discards the isolated worktree only after the Run reaches a terminal state. */
  resolveRunResult(runId: RunId, outcome: "keep" | "discard"): Promise<void>;
  cancelRun(runId: RunId): Promise<void>;
  approveRun(
    runId: RunId,
    approvalId: string,
    scope?: "once" | "run" | "project"
  ): Promise<void>;
  rejectRun(
    runId: RunId,
    approvalId: string,
    scope?: "once" | "run" | "project"
  ): Promise<void>;
  /** Replaces the pending capability with a strictly narrower one for one call. */
  editAndApproveRun(
    runId: RunId,
    approvalId: string,
    replacement: EditedApprovalCapability
  ): Promise<void>;
  answerRun(
    runId: RunId,
    requestId: string,
    value: string,
    commandId?: string
  ): Promise<void>;
  steerRun(runId: RunId, message: string, commandId?: string): Promise<void>;
  /** Browser-side device binding endpoints. */
  createDeviceCode(
    projectId: ProjectId,
    options?: { ttlMs?: number }
  ): Promise<DeviceCodeResult>;
  /** Headless device-side exchange: returns the credential to persist locally. */
  exchangeDeviceCode(input: {
    code: string;
    deviceLabel?: string;
    platform?: string;
  }): Promise<ExchangedDevice>;
  /** Lists devices belonging to the caller; used by the Settings "Trusted devices" surface. */
  listDevices(): Promise<DeviceListing>;
  /** Revokes a device, invalidating its access token for future authenticate() calls. */
  revokeDevice(deviceId: string): Promise<void>;
  /**
   * Returns the persisted device credential, falling back to the value
   * supplied at construction time when no SecureStore is configured.
   */
  deviceCredential(): Promise<ExchangedDevice | undefined>;
  openRunEventStream(
    runId: RunId,
    options?: OpenRunEventStreamOptions
  ): Promise<ReadableStream<Uint8Array>>;
  /** Decodes and validates fragmented SSE frames from the resumable event endpoint. */
  subscribeRunEvents(
    runId: RunId,
    options?: OpenRunEventStreamOptions
  ): AsyncIterable<RunEventV1>;
}

/** Cursor and cancellation inputs used when reconnecting an SSE stream. */
export interface OpenRunEventStreamOptions {
  lastEventId?: string;
  signal?: AbortSignal;
}

/** Result of `POST /api/v1/devices/code`. The clear-text code is the
 *  one-time binding code that the PC client redeems. */
export interface DeviceCodeResult {
  code: string;
  payload: string;
  expiresAt: string;
  projectId: ProjectId;
  projectName: string;
}

/** Result of `POST /api/v1/devices/exchange`; the access token is the
 *  long-lived credential that the PC client persists locally. */
export interface ExchangedDevice {
  deviceId: string;
  accessToken: string;
  userId: string;
  email: string;
  projectId: ProjectId;
  projectName: string;
  deviceLabel: string;
  platform: string;
  expiresAt: string;
  createdAt: string;
}

/** Bounded view returned by `GET /api/v1/devices`. */
export interface DeviceListing {
  devices: Array<{
    deviceId: string;
    projectId: ProjectId;
    projectName: string;
    deviceLabel: string;
    platform: string;
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string;
  }>;
}

export interface ClientOptions {
  baseUrl: string;
  /** Optional single-user bearer token; it is sent only in the Authorization header. */
  accessToken?: string;
  /**
   * Pre-existing device credential for headless device clients. When
   * `secureStore` is also supplied, this option is only used as a one-shot
   * bootstrap value: it is written to the store and ignored on subsequent
   * reads.
   */
  deviceCredential?: ExchangedDevice;
  /**
   * Cross-platform secure store used to persist device credentials between
   * process restarts. When present, `exchangeDeviceCode` and `revokeDevice`
   * route through the store so the latest credential is durable.
   */
  secureStore?: SecureStore;
  fetch?: typeof globalThis.fetch;
}

/** Stable transport failure that lets UI clients distinguish authentication. */
export class LeCodingHttpError extends Error {
  constructor(
    operation: string,
    readonly status: number
  ) {
    super(`${operation}: HTTP ${status}`);
    this.name = "LeCodingHttpError";
  }
}

/** Creates one transport adapter shared by browser, Electron, and Local Runner clients. */
export function createClient(options: ClientOptions): LeCodingClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const authenticatedFetch: typeof globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (options.accessToken) {
      headers.set("authorization", `Bearer ${options.accessToken}`);
    } else {
      // Desktop sessions recover their scoped bearer from the secure store on
      // every process start. The token is attached here in the SDK and never
      // needs to cross the Renderer boundary.
      const credential = await resolveDeviceCredential();
      if (credential) {
        headers.set("authorization", `Bearer ${credential.accessToken}`);
      }
    }
    return fetchImplementation(input, { ...init, headers });
  };

  // The credential store is only built when the caller supplies a
  // SecureStore. It wraps save/load/remove so the SDK's device methods
  // automatically keep the persisted credential in sync.
  let deviceStore: DeviceCredentialStore | undefined;
  if (options.secureStore) {
    deviceStore = createDeviceCredentialStore({ backend: options.secureStore });
  }
  let cachedCredential: ExchangedDevice | undefined = options.deviceCredential;

  async function resolveDeviceCredential(): Promise<ExchangedDevice | undefined> {
    if (cachedCredential) {
      return cachedCredential;
    }
    if (!deviceStore) {
      return undefined;
    }
    const [deviceId] = await deviceStore.list();
    if (!deviceId) {
      return undefined;
    }
    cachedCredential = (await deviceStore.load(deviceId)) as
      | ExchangedDevice
      | undefined;
    return cachedCredential;
  }

  const openRunEventStream = async (
    runId: RunId,
    streamOptions: OpenRunEventStreamOptions = {}
  ): Promise<ReadableStream<Uint8Array>> => {
    const headers = new Headers({ accept: "text/event-stream" });
    if (streamOptions.lastEventId !== undefined) {
      // Fetch-based SSE supports the resume header that browser EventSource cannot set.
      headers.set("last-event-id", streamOptions.lastEventId);
    }

    const response = await authenticatedFetch(
      `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        method: "GET",
        headers,
        ...(streamOptions.signal ? { signal: streamOptions.signal } : {})
      }
    );
    if (!response.ok) {
      throw new LeCodingHttpError("Failed to open Run event stream", response.status);
    }
    if (!response.body) {
      throw new Error("Run event stream response has no body");
    }
    return response.body;
  };

  const sendRunCommand = async (runId: RunId, command: object): Promise<void> => {
    const response = await authenticatedFetch(
      `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/commands`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(command)
      }
    );
    if (!response.ok) {
      throw new LeCodingHttpError("Failed to command Run", response.status);
    }
  };

  return {
    getGitHubLoginUrl(): string {
      return `${baseUrl}/api/v1/auth/github/start`;
    },

    async logout(): Promise<void> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/auth/logout`,
        { method: "POST", credentials: "include" }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to log out", response.status);
      }
    },

    async getControlPlaneConfig(): Promise<ControlPlaneConfig> {
      const response = await authenticatedFetch(`${baseUrl}/api/v1/config`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to load control plane", response.status);
      }
      return (await response.json()) as ControlPlaneConfig;
    },

    async createRun(
      projectId: ProjectId,
      input: CreateRunInput
    ): Promise<CreateRunResult> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/runs`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify(input)
        }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to create Run", response.status);
      }
      return (await response.json()) as CreateRunResult;
    },

    async inspectRun(runId: RunId): Promise<RunView> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}`,
        {
          method: "GET",
          headers: { accept: "application/json" }
        }
      );

      if (!response.ok) {
        throw new LeCodingHttpError("Failed to inspect Run", response.status);
      }

      return (await response.json()) as RunView;
    },

    async listRuns(projectId: ProjectId, limit = 20): Promise<RunHistoryResult> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error("Run history limit must be an integer from 1 to 50");
      }
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/runs?limit=${limit}`,
        { method: "GET", headers: { accept: "application/json" } }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to list Runs", response.status);
      }
      return (await response.json()) as RunHistoryResult;
    },

    async listProjectMemberships(
      projectId: ProjectId
    ): Promise<ProjectMembershipResult> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/memberships`,
        { method: "GET", headers: { accept: "application/json" } }
      );
      if (!response.ok) {
        throw new LeCodingHttpError(
          "Failed to list project memberships",
          response.status
        );
      }
      return (await response.json()) as ProjectMembershipResult;
    },

    async setProjectMembership(projectId, userId, role): Promise<void> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/memberships/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({ role })
        }
      );
      if (!response.ok) {
        throw new LeCodingHttpError(
          "Failed to set project membership",
          response.status
        );
      }
    },

    async removeProjectMembership(projectId, userId): Promise<void> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/memberships/${encodeURIComponent(userId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        throw new LeCodingHttpError(
          "Failed to remove project membership",
          response.status
        );
      }
    },

    async listProjectPolicyRules(projectId): Promise<ProjectPolicyRuleResult> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/policy-rules`,
        { method: "GET", headers: { accept: "application/json" } }
      );
      if (!response.ok) {
        throw new LeCodingHttpError(
          "Failed to list project policy rules",
          response.status
        );
      }
      return (await response.json()) as ProjectPolicyRuleResult;
    },

    async revokeProjectPolicyRule(projectId, ruleId): Promise<void> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/policy-rules/${encodeURIComponent(ruleId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        throw new LeCodingHttpError(
          "Failed to revoke project policy rule",
          response.status
        );
      }
    },

    async getRunChanges(runId: RunId): Promise<RunChanges> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/changes`,
        { method: "GET", headers: { accept: "application/json" } }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to load Run changes", response.status);
      }
      return (await response.json()) as RunChanges;
    },

    async getRunMetrics(runId: RunId): Promise<RunOperationalMetrics> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/metrics`,
        { method: "GET", headers: { accept: "application/json" } }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to load Run metrics", response.status);
      }
      return (await response.json()) as RunOperationalMetrics;
    },

    async getRunArtifact(runId: RunId, artifactId: string): Promise<string> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { method: "GET", headers: { accept: "text/plain" } }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to load Run Artifact", response.status);
      }
      return response.text();
    },

    async resolveRunResult(
      runId: RunId,
      outcome: "keep" | "discard"
    ): Promise<void> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/result`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({ outcome })
        }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to resolve Run result", response.status);
      }
    },

    async cancelRun(runId: RunId): Promise<void> {
      await sendRunCommand(runId, { type: "cancel" });
    },

    async approveRun(
      runId: RunId,
      approvalId: string,
      scope = "once"
    ): Promise<void> {
      await sendRunCommand(runId, { type: "approve", approvalId, scope });
    },

    async rejectRun(
      runId: RunId,
      approvalId: string,
      scope = "once"
    ): Promise<void> {
      await sendRunCommand(runId, { type: "reject", approvalId, scope });
    },

    async editAndApproveRun(runId, approvalId, replacement): Promise<void> {
      await sendRunCommand(runId, {
        type: "edit_approve",
        approvalId,
        replacement
      });
    },

    async answerRun(
      runId: RunId,
      requestId: string,
      value: string,
      commandId?: string
    ): Promise<void> {
      await sendRunCommand(runId, {
        type: "answer",
        commandId: commandId ?? globalThis.crypto.randomUUID(),
        requestId,
        value
      });
    },

    async steerRun(runId: RunId, message: string, commandId?: string): Promise<void> {
      await sendRunCommand(runId, {
        type: "steer",
        commandId: commandId ?? globalThis.crypto.randomUUID(),
        message
      });
    },

    openRunEventStream,

    async *subscribeRunEvents(runId, streamOptions = {}) {
      const stream = await openRunEventStream(runId, streamOptions);
      for await (const event of decodeRunEventStream(stream, runId)) {
        yield event;
      }
    },

    async createDeviceCode(projectId, options = {}) {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/devices/code`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            projectId,
            ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {})
          })
        }
      );
      if (!response.ok) {
        throw new LeCodingHttpError(
          "Failed to create device code",
          response.status
        );
      }
      return (await response.json()) as DeviceCodeResult;
    },

    async exchangeDeviceCode(input) {
      // The device exchange intentionally does NOT send the bearer token: the
      // device is authenticating with a one-time code, not with the browser
      // session that minted it.
      const response = await fetchImplementation(
        `${baseUrl}/api/v1/devices/exchange`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify(input)
        }
      );
      if (!response.ok) {
        throw new LeCodingHttpError(
          "Failed to exchange device code",
          response.status
        );
      }
      const credential = (await response.json()) as ExchangedDevice;
      cachedCredential = credential;
      if (deviceStore) {
        // Persist synchronously so a process crash right after the exchange
        // does not strand the user without credentials.
        await deviceStore.save(credential);
      }
      return credential;
    },

    async listDevices(): Promise<DeviceListing> {
      const response = await authenticatedFetch(`${baseUrl}/api/v1/devices`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to list devices", response.status);
      }
      return (await response.json()) as DeviceListing;
    },

    async revokeDevice(deviceId: string): Promise<void> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/devices/${encodeURIComponent(deviceId)}`,
        {
          method: "DELETE"
        }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to revoke device", response.status);
      }
      if (deviceStore) {
        // Removing from the local store matches the server-side revocation
        // so a re-launched process does not re-authenticate as a dead device.
        await deviceStore.remove(deviceId);
      }
      if (cachedCredential?.deviceId === deviceId) {
        cachedCredential = undefined;
      }
    },

    async deviceCredential(): Promise<ExchangedDevice | undefined> {
      // The persisted store is the source of truth once the Client is
      // configured with one; the constructor-supplied value only acts as a
      // one-shot bootstrap that the exchange call later overwrites.
      if (deviceStore) {
        const keys = await deviceStore.list();
        if (keys.length === 0) {
          return undefined;
        }
        return deviceStore.load(keys[0]!);
      }
      return cachedCredential;
    }
  };
}

/** Parses strict server-produced SSE frames across arbitrary transport chunks. */
async function* decodeRunEventStream(
  stream: ReadableStream<Uint8Array>,
  expectedRunId: RunId
): AsyncGenerator<RunEventV1> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame !== "" && !frame.startsWith(":")) {
          yield parseRunEventFrame(frame, expectedRunId);
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        if (buffer.trim() !== "") {
          throw new Error("Run event stream ended with an incomplete SSE frame");
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseRunEventFrame(frame: string, expectedRunId: RunId): RunEventV1 {
  const fields = new Map<string, string>();
  for (const line of frame.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new Error("Invalid Run event SSE frame");
    }
    fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
  }
  const data = fields.get("data");
  if (!data) {
    throw new Error("Run event SSE frame has no data");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    throw new Error("Run event SSE frame contains invalid JSON");
  }
  const event = parseRunEvent(decoded);
  if (
    event.runId !== expectedRunId ||
    fields.get("id") !== String(event.sequence) ||
    fields.get("event") !== event.type
  ) {
    throw new Error("Run event SSE metadata does not match its envelope");
  }
  return event;
}
