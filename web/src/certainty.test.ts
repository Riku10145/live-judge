import { describe, expect, it } from "vite-plus/test";
import { certaintyVars } from "./certainty.ts";

describe("certaintyVars", () => {
  it("maps 1 and 0 to opposite extremes", () => {
    const high = certaintyVars(1);
    const low = certaintyVars(0);
    expect(Number(high["--saturation"])).toBeGreaterThan(Number(low["--saturation"]));
    expect(Number(high["--glow"])).toBeGreaterThan(Number(low["--glow"]));
    expect(Number(high["--wobble"])).toBe(0);
    expect(Number(low["--wobble"])).toBeGreaterThan(0);
    expect(Number(high["--blur"])).toBe(0);
    expect(Number(low["--blur"])).toBeGreaterThan(0);
    expect(high["--wobble-play"]).toBe("paused");
    expect(low["--wobble-play"]).toBe("running");
  });

  it("is monotonic between 0 and 1", () => {
    const a = certaintyVars(0.2);
    const b = certaintyVars(0.8);
    expect(Number(b["--saturation"])).toBeGreaterThan(Number(a["--saturation"]));
    expect(Number(b["--glow"])).toBeGreaterThan(Number(a["--glow"]));
    expect(Number(b["--wobble"])).toBeLessThan(Number(a["--wobble"]));
    expect(Number(b["--blur"])).toBeLessThan(Number(a["--blur"]));
  });
});
