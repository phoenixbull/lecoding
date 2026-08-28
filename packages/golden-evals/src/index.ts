import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  AgentModel,
  ModelToolResult
} from "@lecoding/run-engine";
import type { RunEnvironment } from "@lecoding/run-environment";

const exec = promisify(execFile);

/** Phase 0 categories used to keep the representative baseline balanced. */
export type GoldenTaskCategory =
  | "bugfix"
  | "feature"
  | "security"
  | "docs"
  | "performance";

/** One deterministic file in a repository fixture. */
export interface GoldenSeedFile {
  path: string;
  content: string;
}

/** A repository definition that can be materialized into a fresh Git fixture. */
export interface GoldenRepository {
  seedFiles: GoldenSeedFile[];
}

/** A reproducible coding task and the public evidence required to accept it. */
export interface GoldenTask {
  id: string;
  title: string;
  category: GoldenTaskCategory;
  task: string;
  repository: GoldenRepository;
  acceptanceCriteria: string[];
  /** Verification commands are argv arrays and must never require shell parsing. */
  verificationCommands: string[][];
}

interface NodeTaskInput {
  id: string;
  title: string;
  category: GoldenTaskCategory;
  task: string;
  source: string;
  test: string;
  acceptance: string;
}

type PythonTaskInput = NodeTaskInput;

/** Builds a dependency-free Node fixture whose test command works offline. */
function nodeTask(input: NodeTaskInput): GoldenTask {
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    task: input.task,
    repository: {
      seedFiles: [
        {
          path: "package.json",
          content: `${JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2)}\n`
        },
        { path: "src/subject.js", content: input.source },
        { path: "test/subject.test.js", content: input.test }
      ]
    },
    acceptanceCriteria: [input.acceptance, "node --test exits with code 0"],
    verificationCommands: [["node", "--test"]]
  };
}

/** Builds a dependency-free Python fixture using the standard unittest runner. */
function pythonTask(input: PythonTaskInput): GoldenTask {
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    task: input.task,
    repository: {
      seedFiles: [
        { path: "subject.py", content: input.source },
        { path: "test_subject.py", content: input.test }
      ]
    },
    acceptanceCriteria: [
      input.acceptance,
      "python3 -m unittest -v exits with code 0"
    ],
    verificationCommands: [["python3", "-m", "unittest", "-v"]]
  };
}

const NODE_TEST_IMPORT = `import test from "node:test";\nimport assert from "node:assert/strict";\n`;

const CATALOG: GoldenTask[] = [
  nodeTask({
    id: "ts-fix-boundary",
    title: "Fix array boundary handling",
    category: "bugfix",
    task: "Fix itemAt so an index equal to the array length returns undefined.",
    source: `export const itemAt = (items, index) => index <= items.length ? items[index] ?? items[0] : undefined;\n`,
    test: `${NODE_TEST_IMPORT}import { itemAt } from "../src/subject.js";\ntest("length is outside", () => assert.equal(itemAt(["a"], 1), undefined));\n`,
    acceptance: "itemAt never wraps an out-of-range index"
  }),
  nodeTask({
    id: "ts-add-required-field",
    title: "Add required field validation",
    category: "feature",
    task: "Reject user records whose trimmed name is empty.",
    source: `export function validateUser(user) { return { ok: true, value: user }; }\n`,
    test: `${NODE_TEST_IMPORT}import { validateUser } from "../src/subject.js";\ntest("blank names fail", () => assert.deepEqual(validateUser({name:"  "}), {ok:false,error:"name_required"}));\n`,
    acceptance: "Blank names return the stable name_required error"
  }),
  nodeTask({
    id: "ts-refactor-parser",
    title: "Parse comma-separated settings",
    category: "feature",
    task: "Implement parseSettings with trimming and empty-item removal.",
    source: `export function parseSettings(value) { return value.split(","); }\n`,
    test: `${NODE_TEST_IMPORT}import { parseSettings } from "../src/subject.js";\ntest("normalizes values", () => assert.deepEqual(parseSettings(" a, ,b "), ["a","b"]));\n`,
    acceptance: "Parser returns only non-empty trimmed settings"
  }),
  nodeTask({
    id: "ts-retry-backoff",
    title: "Bound retry backoff",
    category: "feature",
    task: "Cap exponential retry delays at 200 milliseconds.",
    source: `export const retryDelay = attempt => 25 * 2 ** (attempt - 1);\n`,
    test: `${NODE_TEST_IMPORT}import { retryDelay } from "../src/subject.js";\ntest("caps delay", () => assert.equal(retryDelay(8), 200));\n`,
    acceptance: "Retry delay never exceeds 200 milliseconds"
  }),
  nodeTask({
    id: "js-fix-async-race",
    title: "Prevent stale async writes",
    category: "bugfix",
    task: "Ignore a completion whose version is older than the current state.",
    source: `export const applyCompletion = (state, completion) => ({...state,value:completion.value,version:completion.version});\n`,
    test: `${NODE_TEST_IMPORT}import { applyCompletion } from "../src/subject.js";\ntest("stale completion is ignored", () => assert.deepEqual(applyCompletion({value:"new",version:2},{value:"old",version:1}), {value:"new",version:2}));\n`,
    acceptance: "Older completions cannot overwrite newer state"
  }),
  nodeTask({
    id: "ui-empty-state",
    title: "Render an accessible empty state",
    category: "feature",
    task: "Return an accessible status message when the item list is empty.",
    source: `export const renderItems = items => items.map(String).join(",");\n`,
    test: `${NODE_TEST_IMPORT}import { renderItems } from "../src/subject.js";\ntest("empty state", () => assert.equal(renderItems([]), '<p role="status">No items yet</p>'));\n`,
    acceptance: "An empty list renders the stable role=status message"
  }),
  nodeTask({
    id: "cli-exit-code",
    title: "Return a failing CLI exit code",
    category: "bugfix",
    task: "Return exit code 1 when any verification check fails.",
    source: `export const exitCodeFor = checks => 0;\n`,
    test: `${NODE_TEST_IMPORT}import { exitCodeFor } from "../src/subject.js";\ntest("failed check", () => assert.equal(exitCodeFor([{outcome:"failed"}]), 1));\n`,
    acceptance: "Any failed verification produces exit code 1"
  }),
  pythonTask({
    id: "python-fix-parser",
    title: "Normalize numeric parser input",
    category: "bugfix",
    task: "Accept surrounding whitespace while rejecting partial numbers.",
    source: `def parse_integer(value):\n    return int(value[:2])\n`,
    test: `import unittest\n\nfrom subject import parse_integer\n\n\nclass ParseIntegerTest(unittest.TestCase):\n    def test_rejects_partial_number(self):\n        self.assertIsNone(parse_integer("12x"))\n\n    def test_accepts_surrounding_whitespace(self):\n        self.assertEqual(parse_integer(" 12 "), 12)\n\n\nif __name__ == "__main__":\n    unittest.main()\n`,
    acceptance: "Partial numeric input returns None"
  }),
  pythonTask({
    id: "python-add-validation",
    title: "Validate positive batch size",
    category: "feature",
    task: "Implement validateBatchSize so only integers from 1 through 100 are accepted.",
    source: `def validate_batch_size(value):\n    return {"ok": True, "value": value}\n`,
    test: `import unittest\n\nfrom subject import validate_batch_size\n\n\nclass ValidateBatchSizeTest(unittest.TestCase):\n    def test_accepts_only_inclusive_integer_range(self):\n        self.assertFalse(validate_batch_size(0)["ok"])\n        self.assertFalse(validate_batch_size(101)["ok"])\n        self.assertFalse(validate_batch_size(1.5)["ok"])\n        self.assertTrue(validate_batch_size(50)["ok"])\n\n\nif __name__ == "__main__":\n    unittest.main()\n`,
    acceptance: "Only integer batch sizes in the inclusive 1..100 range pass"
  }),
  nodeTask({
    id: "cache-expiry",
    title: "Expire stale cache entries",
    category: "bugfix",
    task: "Return undefined after an entry's expiresAt timestamp.",
    source: `export const readCache = (entry, now) => entry.value;\n`,
    test: `${NODE_TEST_IMPORT}import { readCache } from "../src/subject.js";\ntest("expired", () => assert.equal(readCache({value:"old",expiresAt:10},11), undefined));\n`,
    acceptance: "Expired entries are never returned"
  }),
  nodeTask({
    id: "api-pagination-boundary",
    title: "Clamp API page size",
    category: "bugfix",
    task: "Clamp page size to the supported 1..100 range.",
    source: `export const pageSize = value => value;\n`,
    test: `${NODE_TEST_IMPORT}import { pageSize } from "../src/subject.js";\ntest("clamps", () => { assert.equal(pageSize(0),1); assert.equal(pageSize(500),100); });\n`,
    acceptance: "Page size is always between 1 and 100"
  }),
  nodeTask({
    id: "error-normalization",
    title: "Normalize unknown errors",
    category: "feature",
    task: "Return a stable message for non-Error thrown values.",
    source: `export const errorMessage = value => value.message;\n`,
    test: `${NODE_TEST_IMPORT}import { errorMessage } from "../src/subject.js";\ntest("unknown value", () => assert.equal(errorMessage("boom"), "Unknown error"));\n`,
    acceptance: "Non-Error values normalize to Unknown error"
  }),
  nodeTask({
    id: "schema-unique-call-id",
    title: "Require unique tool call identity",
    category: "security",
    task: "Add the missing composite unique constraint to the SQL schema string.",
    source: `export const schema = "CREATE TABLE tool_calls (run_id text, call_id text);";\n`,
    test: `${NODE_TEST_IMPORT}import { schema } from "../src/subject.js";\ntest("unique identity", () => assert.match(schema,/UNIQUE\\s*\\(run_id,\\s*call_id\\)/i));\n`,
    acceptance: "Schema uniquely constrains run_id plus call_id"
  }),
  nodeTask({
    id: "api-version-envelope",
    title: "Reject unsupported event versions",
    category: "security",
    task: "Reject event envelopes whose protocol version is not 1.",
    source: `export const parseEnvelope = value => value;\n`,
    test: `${NODE_TEST_IMPORT}import { parseEnvelope } from "../src/subject.js";\ntest("unsupported version", () => assert.throws(() => parseEnvelope({version:2}),/unsupported/i));\n`,
    acceptance: "Unsupported protocol versions throw a stable error"
  }),
  nodeTask({
    id: "security-path-traversal",
    title: "Block path traversal",
    category: "security",
    task: "Reject relative paths that escape the workspace after normalization.",
    source: `export const isSafePath = value => !value.startsWith("/");\n`,
    test: `${NODE_TEST_IMPORT}import { isSafePath } from "../src/subject.js";\ntest("traversal", () => { assert.equal(isSafePath("../secret"),false); assert.equal(isSafePath("src/app.js"),true); });\n`,
    acceptance: "Absolute and parent-traversal paths are rejected"
  }),
  nodeTask({
    id: "security-command-policy",
    title: "Normalize denied executables",
    category: "security",
    task: "Deny an executable by basename even when argv[0] is an absolute path.",
    source: `export const isDenied = (argv0, denied) => denied.includes(argv0);\n`,
    test: `${NODE_TEST_IMPORT}import { isDenied } from "../src/subject.js";\ntest("absolute executable", () => assert.equal(isDenied("/usr/bin/curl",["curl"]),true));\n`,
    acceptance: "Absolute executable paths cannot bypass a basename deny rule"
  }),
  nodeTask({
    id: "docs-quickstart",
    title: "Correct the quickstart order",
    category: "docs",
    task: "Update QUICKSTART so install appears before test and typecheck.",
    source: `export const quickstart = ["pnpm test","pnpm install","pnpm typecheck"];\n`,
    test: `${NODE_TEST_IMPORT}import { quickstart } from "../src/subject.js";\ntest("install first", () => assert.deepEqual(quickstart,["pnpm install","pnpm test","pnpm typecheck"]));\n`,
    acceptance: "Quickstart commands appear in executable order"
  }),
  nodeTask({
    id: "docs-error-reference",
    title: "Document recovery error code",
    category: "docs",
    task: "Add tool_call_outcome_unknown to the exported error reference.",
    source: `export const documentedErrors = ["agent_loop_failed","policy_denied"];\n`,
    test: `${NODE_TEST_IMPORT}import { documentedErrors } from "../src/subject.js";\ntest("recovery error", () => assert.ok(documentedErrors.includes("tool_call_outcome_unknown")));\n`,
    acceptance: "Recovery uncertainty is listed in the error reference"
  }),
  nodeTask({
    id: "performance-deduplicate",
    title: "Deduplicate events in linear time",
    category: "performance",
    task: "Return the first event for each sequence without mutating the input.",
    source: `export const deduplicate = events => events;\n`,
    test: `${NODE_TEST_IMPORT}import { deduplicate } from "../src/subject.js";\ntest("stable dedupe", () => { const input=[{sequence:1,v:"a"},{sequence:1,v:"b"},{sequence:2,v:"c"}]; assert.deepEqual(deduplicate(input),[input[0],input[2]]); });\n`,
    acceptance: "Duplicate sequences are removed while first-seen order is preserved"
  }),
  nodeTask({
    id: "performance-bounded-log",
    title: "Bound retained log output",
    category: "performance",
    task: "Keep only the newest N log entries.",
    source: `export const retainLogs = (entries, limit) => entries;\n`,
    test: `${NODE_TEST_IMPORT}import { retainLogs } from "../src/subject.js";\ntest("newest entries", () => assert.deepEqual(retainLogs([1,2,3,4],2),[3,4]));\n`,
    acceptance: "Retention never returns more than the configured limit"
  })
];

const REPRESENTATIVE_IDS = [
  "ts-fix-boundary",
  "python-add-validation",
  "security-path-traversal",
  "docs-quickstart",
  "performance-deduplicate"
] as const;

const ACCEPTANCE_IDS = [
  "ts-fix-boundary",
  "js-fix-async-race",
  "python-fix-parser",
  "ts-add-required-field",
  "python-add-validation",
  "ui-empty-state",
  "security-path-traversal",
  "schema-unique-call-id",
  "docs-quickstart",
  "docs-error-reference",
  "performance-deduplicate",
  "performance-bounded-log"
] as const;

/** Returns a fresh catalog so one evaluation cannot mutate another run. */
export function loadGoldenTaskCatalog(): GoldenTask[] {
  return structuredClone(CATALOG);
}

/** Selects the stable five-task Phase 0 cost and quality baseline. */
export function selectRepresentativeGoldenTasks(
  catalog: GoldenTask[]
): GoldenTask[] {
  return selectGoldenTasksById(catalog, REPRESENTATIVE_IDS, "Representative");
}

/** Selects the stable category-balanced 12/20 Phase 1 acceptance suite. */
export function selectAcceptanceGoldenTasks(
  catalog: GoldenTask[]
): GoldenTask[] {
  return selectGoldenTasksById(catalog, ACCEPTANCE_IDS, "Acceptance");
}

/** Resolves an immutable suite and fails closed if catalog drift removes a task. */
function selectGoldenTasksById(
  catalog: GoldenTask[],
  ids: readonly string[],
  suiteName: string
): GoldenTask[] {
  const byId = new Map(catalog.map((task) => [task.id, task]));
  return ids.map((id) => {
    const task = byId.get(id);
    if (!task) {
      throw new Error(`${suiteName} golden task is missing: ${id}`);
    }
    return structuredClone(task);
  });
}

/** Caller-selected destination for a new, isolated golden repository. */
export interface MaterializeGoldenTaskOptions {
  repositoryPath: string;
}

/** A clean repository and immutable revision ready for a Run worktree. */
export interface MaterializedGoldenTask {
  repositoryPath: string;
  baseRef: string;
  status: string;
}

/**
 * Materializes a deterministic fixture as a clean Git repository.
 * The destination must not already exist; callers own its eventual cleanup.
 */
export async function materializeGoldenTask(
  task: GoldenTask,
  options: MaterializeGoldenTaskOptions
): Promise<MaterializedGoldenTask> {
  const repositoryPath = resolve(options.repositoryPath);
  if (!isAbsolute(options.repositoryPath)) {
    throw new Error("Golden repositoryPath must be absolute");
  }
  await mkdir(repositoryPath);

  for (const seed of task.repository.seedFiles) {
    const target = resolve(repositoryPath, seed.path);
    const withinRepository = relative(repositoryPath, target);
    if (
      withinRepository === "" ||
      withinRepository === ".." ||
      withinRepository.startsWith(`..${sep}`) ||
      isAbsolute(withinRepository)
    ) {
      throw new Error(`Golden seed path escapes repository: ${seed.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, seed.content, "utf8");
  }

  await exec("git", ["-C", repositoryPath, "init", "--quiet"]);
  await exec("git", ["-C", repositoryPath, "add", "--all"]);
  await exec(
    "git",
    [
      "-C",
      repositoryPath,
      "-c",
      "user.name=LeCoding Golden Eval",
      "-c",
      "user.email=golden-eval@localhost",
      "commit",
      "--quiet",
      "-m",
      `golden fixture: ${task.id}`
    ],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
      }
    }
  );
  const [{ stdout: baseRef }, { stdout: status }] = await Promise.all([
    exec("git", ["-C", repositoryPath, "rev-parse", "HEAD"]),
    exec("git", ["-C", repositoryPath, "status", "--porcelain"])
  ]);
  return {
    repositoryPath,
    baseRef: baseRef.trim(),
    status: status.trim()
  };
}

/** Model/Run composition result required from a real golden-task executor. */
export interface GoldenTaskExecution {
  modelId: string;
  outcome: "passed" | "failed";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failure?: string;
}

/** Provider-neutral execution seam; production implementations must run verification. */
export interface GoldenTaskExecutor {
  execute(task: GoldenTask): Promise<GoldenTaskExecution>;
}

/** A shell-free process invocation used by the real-model evaluation adapter. */
export interface GoldenCommandInvocation {
  file: string;
  args: string[];
  cwd: string;
}

/** Captured process result; non-zero exits remain data so a baseline can continue. */
export interface GoldenCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Executes argv directly without passing untrusted task text through a shell. */
export type GoldenCommandRunner = (
  invocation: GoldenCommandInvocation
) => Promise<GoldenCommandResult>;

/** Explicit rates prevent a model alias or pricing change from corrupting cost evidence. */
export interface GoldenModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

/** Configuration for isolated non-interactive Codex golden-task execution. */
export interface CodexExecGoldenTaskExecutorOptions {
  workingRoot: string;
  modelId: string;
  pricing: GoldenModelPricing;
  codexPath?: string;
  runCommand?: GoldenCommandRunner;
}

/**
 * Creates an executor that gives Codex workspace-only write access, then independently
 * runs every task verification command. The caller owns cleanup of workingRoot.
 */
export function createCodexExecGoldenTaskExecutor(
  options: CodexExecGoldenTaskExecutorOptions
): GoldenTaskExecutor {
  const workingRoot = resolve(options.workingRoot);
  if (!isAbsolute(options.workingRoot)) {
    throw new Error("Codex golden workingRoot must be absolute");
  }
  if (options.modelId.trim() === "") {
    throw new Error("Codex golden modelId must not be empty");
  }
  validatePricing(options.pricing);
  const runCommand = options.runCommand ?? runGoldenCommand;

  return {
    async execute(task) {
      const repositoryPath = join(workingRoot, task.id);
      await materializeGoldenTask(task, { repositoryPath });
      const modelResult = await runCommand({
        file: options.codexPath ?? "codex",
        args: [
          "exec",
          "--json",
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "never",
          "--model",
          options.modelId,
          "-C",
          repositoryPath,
          buildGoldenPrompt(task)
        ],
        cwd: repositoryPath
      });
      const usage = readCodexUsage(modelResult.stdout);
      const costUsd = usage ? calculateCost(usage, options.pricing) : 0;
      if (modelResult.exitCode !== 0) {
        return {
          modelId: options.modelId,
          outcome: "failed",
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costUsd,
          failure: formatCommandFailure("Codex CLI", modelResult)
        };
      }
      // A successful edit without usage cannot support the required cost baseline.
      if (!usage) {
        return {
          modelId: options.modelId,
          outcome: "failed",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          failure: "Codex CLI did not report token usage"
        };
      }

      for (const [file, ...args] of task.verificationCommands) {
        if (!file) {
          throw new Error(`Golden task ${task.id} has an empty verification command`);
        }
        const verification = await runCommand({ file, args, cwd: repositoryPath });
        if (verification.exitCode !== 0) {
          return {
            modelId: options.modelId,
            outcome: "failed",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd,
            failure: formatCommandFailure(`Verification ${file}`, verification)
          };
        }
      }

      return {
        modelId: options.modelId,
        outcome: "passed",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd
      };
    }
  };
}

/** Validated per-request usage emitted by an observable provider model. */
export interface GoldenModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Inputs for evaluating an AgentModel exclusively through a RunEnvironment. */
export interface AgentModelGoldenTaskExecutorOptions {
  workingRoot: string;
  modelId: string;
  pricing: GoldenModelPricing;
  maxTurns?: number;
  createModel(onUsage: (usage: GoldenModelUsage) => void): AgentModel;
  createEnvironment(workspacePath: string): RunEnvironment;
}

/**
 * Creates a real-model executor whose model commands and independent verification
 * both run inside the caller-provided isolated environment.
 */
export function createAgentModelGoldenTaskExecutor(
  options: AgentModelGoldenTaskExecutorOptions
): GoldenTaskExecutor {
  const workingRoot = resolve(options.workingRoot);
  if (!isAbsolute(options.workingRoot)) {
    throw new Error("AgentModel golden workingRoot must be absolute");
  }
  if (options.modelId.trim() === "") {
    throw new Error("AgentModel golden modelId must not be empty");
  }
  validatePricing(options.pricing);
  const maxTurns = options.maxTurns ?? 20;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new Error("AgentModel golden maxTurns must be a positive integer");
  }

  return {
    async execute(task) {
      const repositoryPath = join(workingRoot, task.id);
      await materializeGoldenTask(task, { repositoryPath });
      await makeGoldenWorkspaceWritable(task, repositoryPath);
      const usage = { inputTokens: 0, outputTokens: 0 };
      const model = options.createModel((observation) => {
        validateGoldenUsage(task.id, observation);
        usage.inputTokens += observation.inputTokens;
        usage.outputTokens += observation.outputTokens;
      });
      const environment = options.createEnvironment(repositoryPath);
      const runId = `golden-${task.id}`;
      const handle = await environment.prepare({
        runId,
        projectId: "phase-0-golden",
        environmentId: "golden-sandbox",
        fileAccessScope: "workspace_only"
      });
      const toolResults: ModelToolResult[] = [];
      let failure: string | undefined;

      try {
        let completed = false;
        for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
          const turn = await model.next({
            runId,
            run: {
              projectId: "phase-0-golden",
              environmentId: "golden-sandbox",
              task: task.task,
              acceptanceCriteria: task.acceptanceCriteria,
              approvalMode: "auto_review",
              fileAccessScope: "workspace_only"
            },
            toolResults
          });
          if (turn.type === "completed") {
            completed = true;
            break;
          }
          if (turn.type === "user_request") {
            // Golden evaluations are intentionally unattended, so inventing an answer
            // would invalidate their reproducibility and acceptance evidence.
            failure =
              "AgentModel requested user input during unattended golden evaluation";
            break;
          }
          if (turn.tool === "request_network_egress") {
            // Unattended evaluations cannot manufacture a user/network approval.
            toolResults.push({
              callId: turn.callId,
              ...(turn.continuationId
                ? { continuationId: turn.continuationId }
                : {}),
              status: "denied",
              reason:
                "Network access is unavailable in unattended golden evaluation"
            });
            continue;
          }
          const result = await environment.perform(handle, {
            type: "execute",
            command: turn.arguments.argv
          });
          toolResults.push({
            callId: turn.callId,
            ...(turn.continuationId
              ? { continuationId: turn.continuationId }
              : {}),
            status: "executed",
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr
          });
        }
        if (!completed && !failure) {
          failure = `AgentModel exceeded ${maxTurns} turns`;
        }
        if (!failure) {
          for (const [file, ...args] of task.verificationCommands) {
            if (!file) {
              throw new Error(`Golden task ${task.id} has an empty verification command`);
            }
            const verification = await environment.perform(handle, {
              type: "execute",
              command: [file, ...args]
            });
            if (verification.exitCode !== 0) {
              failure = formatEnvironmentFailure(file, verification);
              break;
            }
          }
        }
      } catch (error) {
        failure = formatAgentModelFailure(error);
      } finally {
        await environment.dispose(handle, failure ? "discard" : "keep");
      }

      const execution = {
        modelId: options.modelId,
        outcome: failure ? ("failed" as const) : ("passed" as const),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: calculateCost(usage, options.pricing)
      };
      return failure ? { ...execution, failure } : execution;
    }
  };
}

async function makeGoldenWorkspaceWritable(
  task: GoldenTask,
  repositoryPath: string
): Promise<void> {
  // Docker's fixed uid 10001 may modify only this disposable fixture, never its parent.
  await chmod(repositoryPath, 0o777);
  const directories = new Set(
    task.repository.seedFiles.map((seed) => dirname(resolve(repositoryPath, seed.path)))
  );
  await Promise.all([
    ...Array.from(directories, (directory) => chmod(directory, 0o777)),
    ...task.repository.seedFiles.map((seed) =>
      chmod(resolve(repositoryPath, seed.path), 0o666)
    )
  ]);
}

function validateGoldenUsage(taskId: string, usage: GoldenModelUsage): void {
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0
  ) {
    throw new Error(`Golden task ${taskId} observed invalid model usage`);
  }
}

function formatEnvironmentFailure(
  file: string,
  result: { exitCode: number; stdout: string; stderr: string }
): string {
  const detail = (result.stderr.trim() || result.stdout.trim() || "no diagnostics").slice(
    0,
    500
  );
  return `Verification ${file} exited with code ${result.exitCode}: ${detail}`;
}

function formatAgentModelFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `AgentModel execution failed: ${message}`.slice(0, 500);
}

async function runGoldenCommand(
  invocation: GoldenCommandInvocation
): Promise<GoldenCommandResult> {
  try {
    const result = await exec(invocation.file, invocation.args, {
      cwd: invocation.cwd,
      maxBuffer: 10 * 1024 * 1024
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message
    };
  }
}

function buildGoldenPrompt(task: GoldenTask): string {
  return [
    task.task,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Modify only this repository. Run the provided tests before finishing."
  ].join("\n");
}

function readCodexUsage(
  stdout: string
): { inputTokens: number; outputTokens: number } | undefined {
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      if (
        event.type === "turn.completed" &&
        Number.isSafeInteger(event.usage?.input_tokens) &&
        Number.isSafeInteger(event.usage?.output_tokens) &&
        Number(event.usage?.input_tokens) >= 0 &&
        Number(event.usage?.output_tokens) >= 0
      ) {
        usage = {
          inputTokens: Number(event.usage?.input_tokens),
          outputTokens: Number(event.usage?.output_tokens)
        };
      }
    } catch {
      // Ignore non-event diagnostics; the missing-usage guard still fails closed.
    }
  }
  return usage;
}

function validatePricing(pricing: GoldenModelPricing): void {
  if (
    !Number.isFinite(pricing.inputUsdPerMillion) ||
    pricing.inputUsdPerMillion < 0 ||
    !Number.isFinite(pricing.outputUsdPerMillion) ||
    pricing.outputUsdPerMillion < 0
  ) {
    throw new Error("Codex golden pricing must contain non-negative finite rates");
  }
}

function calculateCost(
  usage: { inputTokens: number; outputTokens: number },
  pricing: GoldenModelPricing
): number {
  return roundUsd(
    (usage.inputTokens * pricing.inputUsdPerMillion +
      usage.outputTokens * pricing.outputUsdPerMillion) /
      1_000_000
  );
}

function formatCommandFailure(
  label: string,
  result: GoldenCommandResult
): string {
  // Bound persisted diagnostics so an unexpected process dump cannot bloat reports.
  const detail = (result.stderr.trim() || result.stdout.trim() || "no diagnostics").slice(
    0,
    500
  );
  return `${label} exited with code ${result.exitCode}: ${detail}`;
}

/** One immutable task observation in a Phase 0 baseline. */
export interface GoldenBaselineResult extends GoldenTaskExecution {
  taskId: string;
  category: GoldenTaskCategory;
  durationMs: number;
}

/** Aggregate metrics used for the Phase 0 entry decision. */
export interface GoldenBaselineSummary {
  taskCount: number;
  passed: number;
  failed: number;
  passRate: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

/** Versioned report suitable for persistence as an evaluation artifact. */
export interface GoldenBaselineReport {
  schemaVersion: 1;
  createdAt: string;
  results: GoldenBaselineResult[];
  summary: GoldenBaselineSummary;
}

/** Inputs for deterministic timing and a provider-specific executor. */
export interface RunGoldenBaselineOptions {
  tasks: GoldenTask[];
  executor: GoldenTaskExecutor;
  createdAt: string;
  nowMs(): number;
}

/** Runs golden tasks sequentially and returns a validated cost/quality report. */
export async function runGoldenBaseline(
  options: RunGoldenBaselineOptions
): Promise<GoldenBaselineReport> {
  const results: GoldenBaselineResult[] = [];
  for (const task of options.tasks) {
    const startedAt = options.nowMs();
    const execution = await options.executor.execute(structuredClone(task));
    const durationMs = options.nowMs() - startedAt;
    validateExecution(task.id, execution, durationMs);
    results.push({
      taskId: task.id,
      category: task.category,
      ...execution,
      durationMs
    });
  }

  const passed = results.filter((result) => result.outcome === "passed").length;
  const taskCount = results.length;
  return {
    schemaVersion: 1,
    createdAt: options.createdAt,
    results,
    summary: {
      taskCount,
      passed,
      failed: taskCount - passed,
      passRate: taskCount === 0 ? 0 : passed / taskCount,
      inputTokens: sum(results, "inputTokens"),
      outputTokens: sum(results, "outputTokens"),
      costUsd: roundUsd(sum(results, "costUsd")),
      durationMs: sum(results, "durationMs")
    }
  };
}

function validateExecution(
  taskId: string,
  execution: GoldenTaskExecution,
  durationMs: number
): void {
  if (execution.modelId.trim() === "") {
    throw new Error(`Golden task ${taskId} returned an empty modelId`);
  }
  if (
    !Number.isSafeInteger(execution.inputTokens) ||
    execution.inputTokens < 0 ||
    !Number.isSafeInteger(execution.outputTokens) ||
    execution.outputTokens < 0
  ) {
    throw new Error(`Golden task ${taskId} returned invalid token usage`);
  }
  if (!Number.isFinite(execution.costUsd) || execution.costUsd < 0) {
    throw new Error(`Golden task ${taskId} returned invalid cost`);
  }
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`Golden task ${taskId} returned invalid duration`);
  }
}

function sum(
  results: GoldenBaselineResult[],
  field: "inputTokens" | "outputTokens" | "costUsd" | "durationMs"
): number {
  return results.reduce((total, result) => total + result[field], 0);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
