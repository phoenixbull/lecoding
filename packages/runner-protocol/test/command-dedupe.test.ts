import { describe, expect, it, vi } from "vitest";
import { createCommandDedupe } from "../src/command-dedupe.js";
import type { RunnerCommandOutcome } from "../src/envelope.js";

const ok: RunnerCommandOutcome = { ok: true, value: { exitCode: 0 } };
const failed: RunnerCommandOutcome = { ok: false, code: "scope_violation", message: "no" };

/** Resolves on demand so tests can control when a command "finishes". */
function deferred() {
  let resolve!: (outcome: RunnerCommandOutcome) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<RunnerCommandOutcome>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createCommandDedupe", () => {
  it("executes a command the first time it is seen", async () => {
    const dedupe = createCommandDedupe();
    const execute = vi.fn().mockResolvedValue(ok);

    await expect(dedupe.run(1, execute)).resolves.toEqual(ok);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns the cached outcome instead of re-executing a completed command", async () => {
    // This is the whole point of commandId: a resend after reconnect must not
    // repeat a side effect, so `execute` must not run a second time.
    const dedupe = createCommandDedupe();
    const execute = vi.fn().mockResolvedValue(ok);

    await dedupe.run(1, execute);
    await expect(dedupe.run(1, execute)).resolves.toEqual(ok);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("caches failures as well as successes", async () => {
    const dedupe = createCommandDedupe();
    const execute = vi.fn().mockResolvedValue(failed);

    await expect(dedupe.run(1, execute)).resolves.toEqual(failed);
    await expect(dedupe.run(1, execute)).resolves.toEqual(failed);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs a concurrent resend only once and shares the outcome", async () => {
    // A resend that arrives while the first attempt is still executing must
    // attach to it, not start a second execution.
    const dedupe = createCommandDedupe();
    const pending = deferred();
    const execute = vi.fn().mockReturnValue(pending.promise);

    const first = dedupe.run(1, execute);
    const second = dedupe.run(1, execute);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(dedupe.status(1)).toBe("running");

    pending.resolve(ok);
    await expect(first).resolves.toEqual(ok);
    await expect(second).resolves.toEqual(ok);
    expect(dedupe.status(1)).toBe("settled");
  });

  it("shares a failure with every attached caller", async () => {
    const dedupe = createCommandDedupe();
    const pending = deferred();
    const execute = vi.fn().mockReturnValue(pending.promise);

    const first = dedupe.run(5, execute);
    const second = dedupe.run(5, execute);
    pending.resolve(failed);

    await expect(first).resolves.toEqual(failed);
    await expect(second).resolves.toEqual(failed);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports unknown commands without executing", () => {
    const dedupe = createCommandDedupe();
    expect(dedupe.status(7)).toBe("unknown");
    expect(dedupe.peek(7)).toBeUndefined();
  });

  it("peeks a settled outcome", async () => {
    const dedupe = createCommandDedupe();
    await dedupe.run(2, vi.fn().mockResolvedValue(ok));
    expect(dedupe.peek(2)).toEqual(ok);
  });

  it("treats a thrown error as a terminal internal failure", async () => {
    // Caching the failure is the fail-safe choice: if execution threw we cannot
    // know which side effects landed, so re-running could repeat them.
    const dedupe = createCommandDedupe();
    const execute = vi.fn().mockRejectedValue(new Error("spawn failed"));

    await expect(dedupe.run(1, execute)).resolves.toEqual({
      ok: false,
      code: "internal",
      message: "spawn failed"
    });
    await expect(dedupe.run(1, execute)).resolves.toMatchObject({ code: "internal" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  describe("seed", () => {
    it("prevents execution of a command restored from the durable journal", async () => {
      // M2.3: after a restart the journal replays "started but outcome unknown".
      // The Runner must answer with command_interrupted rather than re-run.
      const dedupe = createCommandDedupe();
      const interrupted: RunnerCommandOutcome = {
        ok: false,
        code: "command_interrupted",
        message: "Runner restarted before the outcome was recorded"
      };
      expect(dedupe.seed(3, interrupted)).toBe(true);

      const execute = vi.fn().mockResolvedValue(ok);
      await expect(dedupe.run(3, execute)).resolves.toEqual(interrupted);
      expect(execute).not.toHaveBeenCalled();
    });

    it("does not overwrite an outcome already known", async () => {
      // The first record wins: replaying a journal must not clobber a fresher
      // result recorded in this session.
      const dedupe = createCommandDedupe();
      await dedupe.run(1, vi.fn().mockResolvedValue(ok));

      expect(dedupe.seed(1, failed)).toBe(false);
      expect(dedupe.peek(1)).toEqual(ok);
    });

    it("ignores a duplicate seed of the same value", () => {
      const dedupe = createCommandDedupe();
      expect(dedupe.seed(1, failed)).toBe(true);
      expect(dedupe.seed(1, failed)).toBe(false);
      expect(dedupe.size()).toBe(1);
    });
  });

  describe("bounded growth", () => {
    it("evicts the oldest settled command when the cap is exceeded", async () => {
      const dedupe = createCommandDedupe({ maxTrackedCommands: 3 });
      await dedupe.run(1, vi.fn().mockResolvedValue(ok));
      await dedupe.run(2, vi.fn().mockResolvedValue(ok));
      await dedupe.run(3, vi.fn().mockResolvedValue(ok));
      await dedupe.run(4, vi.fn().mockResolvedValue(ok));

      expect(dedupe.size()).toBe(3);
      expect(dedupe.status(1)).toBe("unknown");
      expect(dedupe.status(4)).toBe("settled");
    });

    it("never evicts a command that is still running", async () => {
      // Evicting an in-flight entry would let a resend start a second execution.
      const dedupe = createCommandDedupe({ maxTrackedCommands: 2 });
      const pending = deferred();
      void dedupe.run(1, vi.fn().mockReturnValue(pending.promise));
      await dedupe.run(2, vi.fn().mockResolvedValue(ok));
      await dedupe.run(3, vi.fn().mockResolvedValue(ok));

      expect(dedupe.status(1)).toBe("running");
      expect(dedupe.status(3)).toBe("settled");

      pending.resolve(ok);
    });

    it("tracks commands independently by id", async () => {
      const dedupe = createCommandDedupe();
      await dedupe.run(1, vi.fn().mockResolvedValue(ok));
      await dedupe.run(2, vi.fn().mockResolvedValue(failed));
      expect(dedupe.peek(1)).toEqual(ok);
      expect(dedupe.peek(2)).toEqual(failed);
      expect(dedupe.size()).toBe(2);
    });
  });
});
