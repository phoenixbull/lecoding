import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTargetLinuxIsolationEvidence } from "../../../scripts/run-target-linux-isolation.mjs";

describe("runTargetLinuxIsolationEvidence", () => {
  it("refuses to produce target-Linux evidence on a non-Linux host", async () => {
    let commandCount = 0;

    await expect(
      runTargetLinuxIsolationEvidence({
        platform: "darwin",
        runCommand: async () => {
          commandCount += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      })
    ).rejects.toThrow("Target Linux isolation evidence requires a Linux host");
    expect(commandCount).toBe(0);
  });

  it("builds the sandbox, requires the full matrix, and persists auditable Linux metadata", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "lecoding-linux-evidence-"));
    const outputPath = join(outputRoot, "report.json");
    const invocations: Array<{
      file: string;
      args: string[];
      env?: Record<string, string>;
    }> = [];
    try {
      const report = await runTargetLinuxIsolationEvidence({
        platform: "linux",
        architecture: "x64",
        kernelRelease: "6.8.0-worker",
        createdAt: "2026-08-25T10:00:00.000Z",
        repositoryRoot: "/srv/lecoding",
        outputPath,
        runCommand: async (invocation) => {
          invocations.push(invocation);
          if (invocation.args[0] === "info") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ServerVersion: "27.5.1",
                OperatingSystem: "Ubuntu 24.04",
                OSType: "linux",
                Architecture: "x86_64",
                CgroupVersion: "2",
                SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"]
              }),
              stderr: ""
            };
          }
          if (invocation.args[0] === "image") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Id: "sha256:image-id",
                RepoDigests: ["lecoding-sandbox@sha256:image-digest"]
              }),
              stderr: ""
            };
          }
          return { exitCode: 0, stdout: "Tests 6 passed", stderr: "" };
        }
      });

      expect(report).toMatchObject({
        schemaVersion: 1,
        createdAt: "2026-08-25T10:00:00.000Z",
        host: { platform: "linux", architecture: "x64", kernelRelease: "6.8.0-worker" },
        docker: {
          serverVersion: "27.5.1",
          operatingSystem: "Ubuntu 24.04",
          osType: "linux",
          architecture: "x86_64",
          cgroupVersion: "2"
        },
        image: { id: "sha256:image-id" },
        matrix: { outcome: "passed" }
      });
      expect(invocations.map(({ file, args }) => [file, ...args])).toEqual([
        ["docker", "info", "--format", "{{json .}}"],
        [
          "docker",
          "build",
          "-f",
          "docker/sandbox.Dockerfile",
          "-t",
          "lecoding-sandbox:phase0",
          "."
        ],
        ["docker", "image", "inspect", "lecoding-sandbox:phase0", "--format", "{{json .}}"],
        [
          "pnpm",
          "vitest",
          "run",
          "packages/run-environment/test/docker-environment.test.ts"
        ]
      ]);
      expect(invocations[3]?.env).toMatchObject({
        REQUIRE_TARGET_LINUX_DOCKER: "1",
        LECODING_DOCKER_TEST_IMAGE: "lecoding-sandbox:phase0"
      });
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("rejects a green test process when any Docker matrix case was skipped", async () => {
    await expect(
      runTargetLinuxIsolationEvidence({
        platform: "linux",
        repositoryRoot: "/srv/lecoding",
        runCommand: async (invocation) => {
          if (invocation.args[0] === "info") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ServerVersion: "27.5.1",
                OperatingSystem: "Ubuntu 24.04",
                OSType: "linux",
                Architecture: "x86_64",
                CgroupVersion: "2"
              }),
              stderr: ""
            };
          }
          if (invocation.args[0] === "image") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ Id: "sha256:image-id" }),
              stderr: ""
            };
          }
          if (invocation.file === "pnpm") {
            return {
              exitCode: 0,
              stdout: "Tests 4 passed | 2 skipped (6)",
              stderr: ""
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      })
    ).rejects.toThrow("Target Linux Docker matrix contained skipped tests");
  });
});
