import type { JudgeError, Judgment } from "./types.ts";

export type Phase =
  | { kind: "idle" }
  | { kind: "judging"; seq: number; text: string }
  | { kind: "judged"; seq: number; text: string; result: Judgment }
  | { kind: "failed"; seq: number; text: string; error: JudgeError };

export type Clock = {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
};

export type JudgeFn = (text: string) => Promise<Judgment>;

export type SessionListener = (phase: Phase, previous: Judgment | null) => void;

const MIN_CHARS = 2;
const DEBOUNCE_MS = 650;

export class Session {
  phase: Phase = { kind: "idle" };
  previous: Judgment | null = null;
  private seq = 0;
  private debounceId: number | null = null;
  private lastJudged = "";
  private draft = "";
  private readonly judge: JudgeFn;
  private readonly clock: Clock;
  private readonly onChange: SessionListener;
  private readonly debounceMs: number;

  constructor(judge: JudgeFn, clock: Clock, onChange: SessionListener, debounceMs = DEBOUNCE_MS) {
    this.judge = judge;
    this.clock = clock;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  type(text: string): void {
    this.draft = text;
    if (this.debounceId !== null) this.clock.clearTimeout(this.debounceId);
    this.debounceId = this.clock.setTimeout(() => {
      this.debounceId = null;
      void this.issue(this.draft, false);
    }, this.debounceMs);
  }

  force(text: string): void {
    this.draft = text;
    if (this.debounceId !== null) {
      this.clock.clearTimeout(this.debounceId);
      this.debounceId = null;
    }
    void this.issue(text, true);
  }

  private async issue(raw: string, forced: boolean): Promise<void> {
    const text = raw.trim();
    if (text.length < MIN_CHARS) return;
    if (!forced && text === this.lastJudged) return;

    const seq = ++this.seq;
    this.phase = { kind: "judging", seq, text };
    this.onChange(this.phase, this.previous);

    try {
      const result = await this.judge(text);
      if (seq !== this.seq) return;
      this.lastJudged = text;
      this.previous = result;
      this.phase = { kind: "judged", seq, text, result };
      this.onChange(this.phase, this.previous);
    } catch (caught) {
      if (seq !== this.seq) return;
      this.phase = { kind: "failed", seq, text, error: asJudgeError(caught) };
      this.onChange(this.phase, this.previous);
    }
  }
}

function asJudgeError(caught: unknown): JudgeError {
  if (isJudgeError(caught)) return caught;
  return { kind: "malformed", message: "judgment failed" };
}

export function isJudgeError(value: unknown): value is JudgeError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof value.kind === "string" &&
    typeof value.message === "string"
  );
}
