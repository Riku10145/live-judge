import { describe, expect, it } from "vite-plus/test";
import { Session, type Clock } from "./session.ts";
import type { Judgment } from "./types.ts";

function judgment(text: string): Judgment {
  return {
    source: "demo",
    model: "demo",
    elapsedMs: 1,
    usage: null,
    verdicts: {
      positivity: { type: "boolean", probability: text.length > 4 ? 0.9 : 0.1, certainty: 0.8 },
    },
  };
}

class FakeClock implements Clock {
  nowMs = 0;
  private nextId = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, at: this.nowMs + ms, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }

  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.timers.filter((timer) => timer.at <= this.nowMs);
    this.timers = this.timers.filter((timer) => timer.at > this.nowMs);
    for (const timer of due) timer.fn();
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Session", () => {
  it("drops a stale response that arrives after a newer one", async () => {
    const resolvers: ((value: Judgment) => void)[] = [];
    const clock = new FakeClock();
    const session = new Session(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
      clock,
      () => {},
    );

    session.force("first text");
    session.force("second text");
    expect(resolvers.length).toBe(2);

    resolvers[0](judgment("first text"));
    await flush();
    expect(session.phase.kind).toBe("judging");

    resolvers[1](judgment("second text"));
    await flush();
    expect(session.phase).toMatchObject({ kind: "judged", text: "second text" });
  });

  it("does not issue a second request for identical consecutive text", async () => {
    let calls = 0;
    const clock = new FakeClock();
    const session = new Session(
      async (text) => {
        calls += 1;
        return judgment(text);
      },
      clock,
      () => {},
    );

    session.type("same phrase here");
    clock.advance(650);
    await flush();
    session.type("same phrase here");
    clock.advance(650);
    await flush();
    expect(calls).toBe(1);
  });

  it("issues no request for text under the minimum length", async () => {
    let calls = 0;
    const clock = new FakeClock();
    const session = new Session(
      async (text) => {
        calls += 1;
        return judgment(text);
      },
      clock,
      () => {},
    );

    session.type("あ");
    clock.advance(650);
    await flush();
    expect(calls).toBe(0);
  });

  it("forces a judge without waiting for the debounce", async () => {
    let calls = 0;
    const clock = new FakeClock();
    const session = new Session(
      async (text) => {
        calls += 1;
        return judgment(text);
      },
      clock,
      () => {},
    );

    session.type("forced right now");
    expect(calls).toBe(0);
    session.force("forced right now");
    await flush();
    expect(calls).toBe(1);
    expect(session.phase.kind).toBe("judged");
  });
});
