import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const IMAGE = "lecoding-sandbox:phase0";
const MATRIX_FILE = "packages/run-environment/test/docker-environment.test.ts";

/**
 * Produces target-host isolation evidence only when the caller proves it is
 * running on Linux. Docker Desktop's VM must never satisfy this host check.
 */
export async function runTargetLinuxIsolationEvidence(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new Error("Target Linux isolation evidence requires a Linux host");
  }
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const outputPath = resolve(
    options.outputPath ?? resolve(repositoryRoot, ".artifacts/target-linux-isolation.json")
  );
  const runCommand = options.runCommand ?? runProcess;
  const invoke = async (invocation) => {
    const result = await runCommand({ ...invocation, cwd: repositoryRoot });
    if (result.exitCode !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || "no diagnostics").slice(
        0,
        500
      );
      throw new Error(
        `${invocation.file} ${invocation.args.join(" ")} failed with code ${result.exitCode}: ${detail}`
      );
    }
    return result;
  };

  const dockerInfoResult = await invoke({
    file: "docker",
    args: ["info", "--format", "{{json .}}"]
  });
  const dockerInfo = parseJsonObject(dockerInfoResult.stdout, "docker info");
  if (dockerInfo.OSType !== "linux") {
    throw new Error("Target Linux isolation evidence requires a Linux Docker daemon");
  }
  await invoke({
    file: "docker",
    args: [
      "build",
      "-f",
      "docker/sandbox.Dockerfile",
      "-t",
      IMAGE,
      "."
    ]
  });
  const imageResult = await invoke({
    file: "docker",
    args: ["image", "inspect", IMAGE, "--format", "{{json .}}"]
  });
  const image = parseJsonObject(imageResult.stdout, "docker image inspect");
  const matrixResult = await invoke({
    file: "pnpm",
    args: ["vitest", "run", MATRIX_FILE],
    env: {
      ...process.env,
      REQUIRE_TARGET_LINUX_DOCKER: "1",
      LECODING_DOCKER_TEST_IMAGE: IMAGE
    }
  });
  if (/\bskipped\b/iu.test(matrixResult.stdout)) {
    throw new Error("Target Linux Docker matrix contained skipped tests");
  }

  const report = {
    schemaVersion: 1,
    createdAt: options.createdAt ?? new Date().toISOString(),
    host: {
      platform,
      architecture: options.architecture ?? arch(),
      kernelRelease: options.kernelRelease ?? release()
    },
    docker: {
      serverVersion: requireText(dockerInfo.ServerVersion, "Docker server version"),
      operatingSystem: requireText(
        dockerInfo.OperatingSystem,
        "Docker operating system"
      ),
      osType: requireText(dockerInfo.OSType, "Docker OS type"),
      architecture: requireText(dockerInfo.Architecture, "Docker architecture"),
      cgroupVersion: requireText(dockerInfo.CgroupVersion, "Docker cgroup version"),
      securityOptions: Array.isArray(dockerInfo.SecurityOptions)
        ? dockerInfo.SecurityOptions.filter((value) => typeof value === "string")
        : []
    },
    image: {
      reference: IMAGE,
      id: requireText(image.Id, "Docker image id"),
      repoDigests: Array.isArray(image.RepoDigests)
        ? image.RepoDigests.filter((value) => typeof value === "string")
        : []
    },
    matrix: {
      testFile: MATRIX_FILE,
      outcome: "passed",
      // Keep a bounded summary without persisting unrelated process environment data.
      output: matrixResult.stdout.trim().slice(-2_000)
    }
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function runProcess(invocation) {
  try {
    const result = await exec(invocation.file, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      maxBuffer: 10 * 1024 * 1024
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr:
        typeof error?.stderr === "string"
          ? error.stderr
          : error instanceof Error
            ? error.message
            : String(error)
    };
  }
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return parsed;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is missing`);
  }
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const outputPath = process.argv[2];
  runTargetLinuxIsolationEvidence({ ...(outputPath ? { outputPath } : {}) })
    .then((report) => {
      process.stdout.write(
        `${JSON.stringify({ outcome: report.matrix.outcome, outputPath: resolve(outputPath ?? ".artifacts/target-linux-isolation.json") })}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
