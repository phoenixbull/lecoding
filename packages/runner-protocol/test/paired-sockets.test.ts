import { describe, expect, it } from "vitest";
import { createPairedRunnerSockets } from "../src/paired-sockets.js";

describe("createPairedRunnerSockets", () => {
  it("delivers text from a to b and back", () => {
    const pair = createPairedRunnerSockets();
    const atB: string[] = [];
    const atA: string[] = [];
    pair.b.onMessage((text) => atB.push(text));
    pair.a.onMessage((text) => atA.push(text));

    pair.a.send("ping");
    pair.b.send("pong");

    expect(atB).toEqual(["ping"]);
    expect(atA).toEqual(["pong"]);
  });

  it("resolves a request/response exchange synchronously", () => {
    // The protocol state machine should not need to await a microtask, so the
    // pair must flush inline. Without this, every session test would need
    // artificial awaits and could hide ordering bugs.
    const pair = createPairedRunnerSockets();
    const seen: string[] = [];
    pair.b.onMessage((text) => {
      seen.push(text);
      pair.b.send(`ack:${text}`);
    });
    pair.a.onMessage((text) => seen.push(text));

    pair.a.send("cmd");
    expect(seen).toEqual(["cmd", "ack:cmd"]);
  });

  it("handles a long exchange without growing the stack", () => {
    // A ping-pong of 5000 rounds would blow a recursive delivery loop.
    const pair = createPairedRunnerSockets();
    let received = 0;
    const rounds = 5_000;
    pair.b.onMessage(() => {
      received += 1;
      pair.b.send("b");
    });
    pair.a.onMessage(() => {
      received += 1;
      if (received < rounds * 2) {
        pair.a.send("a");
      }
    });

    pair.a.send("a");
    expect(received).toBe(rounds * 2);
  });

  it("queues frames when autoDeliver is disabled", () => {
    const pair = createPairedRunnerSockets({ autoDeliver: false });
    const atB: string[] = [];
    pair.b.onMessage((text) => atB.push(text));

    pair.a.send("one");
    pair.a.send("two");
    expect(atB).toEqual([]);
    expect(pair.queued()).toBe(2);

    pair.deliver(1);
    expect(atB).toEqual(["one"]);

    pair.deliver();
    expect(atB).toEqual(["one", "two"]);
    expect(pair.queued()).toBe(0);
  });

  it("records dropped frames on the wire but never delivers them", () => {
    // The wire log is ground truth: a dropped frame still happened, which is
    // what reconnection tests assert against.
    const pair = createPairedRunnerSockets({ autoDeliver: false });
    const atB: string[] = [];
    pair.b.onMessage((text) => atB.push(text));

    pair.a.send("lost");
    pair.a.send("kept");
    pair.drop(1);

    expect(pair.wire().map((frame) => frame.text)).toEqual(["lost", "kept"]);
    expect(pair.queued()).toBe(1);

    pair.deliver();
    expect(atB).toEqual(["kept"]);
  });

  it("labels the sender on every wire frame", () => {
    const pair = createPairedRunnerSockets({ autoDeliver: false });
    pair.a.send("from-a");
    pair.b.send("from-b");
    expect(pair.wire()).toEqual([
      { from: "a", text: "from-a" },
      { from: "b", text: "from-b" }
    ]);
  });

  it("notifies both sides on close and discards queued frames", () => {
    const pair = createPairedRunnerSockets({ autoDeliver: false });
    const closes: Array<{ side: string; code: number; reason: string }> = [];
    pair.a.onClose((info) => closes.push({ side: "a", ...info }));
    pair.b.onClose((info) => closes.push({ side: "b", ...info }));
    const atB: string[] = [];
    pair.b.onMessage((text) => atB.push(text));

    pair.a.send("in-flight");
    pair.a.close(4001, "device revoked");
    pair.deliver();

    expect(closes).toEqual([
      { side: "a", code: 4001, reason: "device revoked" },
      { side: "b", code: 4001, reason: "device revoked" }
    ]);
    expect(atB).toEqual([]);
    expect(pair.closed()).toBe(true);
  });

  it("makes send after close a no-op", () => {
    // A heartbeat timer firing during teardown must not throw.
    const pair = createPairedRunnerSockets();
    const atB: string[] = [];
    pair.b.onMessage((text) => atB.push(text));

    pair.b.close(4000, "done");
    expect(() => pair.a.send("after-close")).not.toThrow();
    expect(atB).toEqual([]);
  });

  it("stops delivering once the pair closes mid-flush", () => {
    const pair = createPairedRunnerSockets({ autoDeliver: false });
    const atA: string[] = [];
    pair.a.onMessage((text) => {
      atA.push(text);
      pair.a.close(4002, "protocol violation");
    });

    pair.b.send("first");
    pair.b.send("second");
    pair.deliver();

    expect(atA).toEqual(["first"]);
  });

  it("unsubscribes message and close listeners", () => {
    const pair = createPairedRunnerSockets();
    const seen: string[] = [];
    const off = pair.b.onMessage((text) => seen.push(text));

    pair.a.send("one");
    off();
    pair.a.send("two");

    expect(seen).toEqual(["one"]);
  });
});
