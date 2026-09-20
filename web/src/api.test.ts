import { describe, expect, it } from "vite-plus/test";
import { parseJudgment } from "./api.ts";

const valid = {
  source: "live",
  model: "typesafe-ai/jev",
  elapsedMs: 12,
  usage: { inputTokens: 10, outputTokens: 0 },
  verdicts: {
    positivity: { type: "boolean", probability: 0.9, certainty: 0.8 },
  },
};

describe("parseJudgment", () => {
  it("accepts a well-formed live payload", () => {
    const parsed = parseJudgment(valid);
    expect(parsed).toEqual(valid);
  });

  it("rejects a payload with no verdicts", () => {
    expect(parseJudgment({ source: "live", model: "x", elapsedMs: 1, usage: null })).toBe(null);
  });

  it("rejects a wrong type tag", () => {
    expect(
      parseJudgment({
        ...valid,
        verdicts: { positivity: { type: "meter", probability: 0.9, certainty: 0.8 } },
      }),
    ).toBe(null);
  });

  it("rejects a non-numeric probability", () => {
    expect(
      parseJudgment({
        ...valid,
        verdicts: { positivity: { type: "boolean", probability: "high", certainty: 0.8 } },
      }),
    ).toBe(null);
  });
});
