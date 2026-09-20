export type CertaintyVars = {
  "--certainty": string;
  "--wobble": string;
  "--saturation": string;
  "--blur": string;
  "--glow": string;
  "--wobble-play": "running" | "paused";
};

export function certaintyVars(certainty: number): CertaintyVars {
  const c = clamp01(certainty);
  const wobble = (1 - c) * 5;
  return {
    "--certainty": format(c),
    "--wobble": format(wobble),
    "--saturation": format(28 + c * 72),
    "--blur": format((1 - c) * 0.2),
    "--glow": format(c * 0.55),
    "--wobble-play": c >= 0.82 ? "paused" : "running",
  };
}

export function applyCertainty(el: HTMLElement, certainty: number | null): void {
  if (certainty === null) {
    el.style.removeProperty("--certainty");
    el.style.removeProperty("--wobble");
    el.style.removeProperty("--saturation");
    el.style.removeProperty("--blur");
    el.style.removeProperty("--glow");
    el.style.removeProperty("--wobble-play");
    return;
  }
  const vars = certaintyVars(certainty);
  el.style.setProperty("--certainty", vars["--certainty"]);
  el.style.setProperty("--wobble", vars["--wobble"]);
  el.style.setProperty("--saturation", vars["--saturation"]);
  el.style.setProperty("--blur", vars["--blur"]);
  el.style.setProperty("--glow", vars["--glow"]);
  el.style.setProperty("--wobble-play", vars["--wobble-play"]);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function format(value: number): string {
  return value.toFixed(3);
}
