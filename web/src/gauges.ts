import type {
  CriterionKind,
  CriterionMeta,
  JudgedCriterion,
  NamedOption,
  ScoreCriterion,
} from "./api.ts";

export type GaugePhase = "idle" | "judging" | "ready" | "error";

type GaugeHandle = {
  root: HTMLElement;
  setPhase: (phase: GaugePhase, judgment?: JudgedCriterion) => void;
};

export function createGauges(meta: readonly CriterionMeta[]): {
  root: HTMLElement;
  setPhase: (phase: GaugePhase, judgments: readonly JudgedCriterion[]) => void;
} {
  const root = document.createElement("section");
  root.className = "gauges";
  root.setAttribute("aria-label", "判定");
  const handles = meta.map((item) => {
    const handle = buildGauge(item);
    root.append(handle.root);
    return { id: item.id, handle };
  });
  return {
    root,
    setPhase(phase, judgments) {
      const byId = new Map(judgments.map((item) => [item.id, item]));
      for (const { id, handle } of handles) {
        handle.setPhase(phase, byId.get(id));
      }
    },
  };
}

function buildGauge(meta: CriterionMeta): GaugeHandle {
  switch (meta.kind) {
    case "boolean":
      return booleanGauge(meta);
    case "score":
      return scoreGauge(meta);
    case "choice":
      return choiceGauge(meta);
    default: {
      const _never: never = meta;
      throw new Error(`unhandled kind ${JSON.stringify(_never)}`);
    }
  }
}

function booleanGauge(meta: Extract<CriterionMeta, { kind: "boolean" }>): GaugeHandle {
  const { root, meter, visual } = panel(meta, "boolean");
  const svg = svgEl("svg", { viewBox: "0 0 200 120", "aria-hidden": "true" });
  const track = svgEl("path", {
    class: "arc-track",
    d: "M 24 108 A 76 76 0 0 0 176 108",
    fill: "none",
    pathLength: "100",
  });
  const value = svgEl("path", {
    class: "arc-value",
    d: "M 24 108 A 76 76 0 0 0 176 108",
    fill: "none",
    pathLength: "100",
  });
  value.setAttribute("stroke-dasharray", "0 100");
  svg.append(track, value);
  const readout = el("div", "readout");
  visual.append(svg, readout);
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", "100");

  return {
    root,
    setPhase(phase, judgment) {
      const reading = judgment?.kind === "boolean" ? judgment : undefined;
      setConfidence(root, phase, reading?.confidence ?? null);
      if (phase === "idle" || phase === "error" || !reading) {
        value.setAttribute("stroke-dasharray", "0 100");
        readout.textContent = "";
        meter.removeAttribute("aria-valuenow");
        meter.removeAttribute("aria-valuetext");
        return;
      }
      const pct = Math.round(reading.probability * 100);
      value.setAttribute("stroke-dasharray", `${reading.probability * 100} 100`);
      readout.textContent = `${pct}%`;
      meter.setAttribute("aria-valuenow", String(pct));
      meter.setAttribute("aria-valuetext", `${pct}パーセント`);
    },
  };
}

function scoreGauge(meta: Extract<CriterionMeta, { kind: "score" }>): GaugeHandle {
  const { root, meter, visual } = panel(meta, "score");
  const track = el("div", "bar-track");
  const segs = el("div", "bar-segs");
  const fill = el("div", "bar-fill");
  const marker = el("div", "bar-marker");
  track.append(segs, fill, marker);
  const labels = el("div", "bar-labels");
  writeLabels(labels, meta.levels);
  visual.append(track, labels);
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", String(Math.max(meta.levels.length - 1, 1)));

  return {
    root,
    setPhase(phase, judgment) {
      const reading = judgment?.kind === "score" ? judgment : undefined;
      setConfidence(root, phase, reading?.confidence ?? null);
      if (phase === "idle" || phase === "error" || !reading) {
        segs.replaceChildren();
        fill.style.width = "0%";
        marker.style.opacity = "0";
        meter.removeAttribute("aria-valuenow");
        meter.removeAttribute("aria-valuetext");
        return;
      }
      writeLabels(labels, reading.levels);
      writeEqualSegs(segs, reading.probabilities);
      const span = Math.max(reading.levels.length - 1, 1);
      const t = clamp01(reading.score / span);
      fill.style.width = `${t * 100}%`;
      marker.style.left = `${t * 100}%`;
      marker.style.opacity = "1";
      meter.setAttribute("aria-valuemax", String(span));
      meter.setAttribute("aria-valuenow", String(reading.score));
      meter.setAttribute("aria-valuetext", nearestLevel(reading));
    },
  };
}

function choiceGauge(meta: Extract<CriterionMeta, { kind: "choice" }>): GaugeHandle {
  const { root, meter, visual } = panel(meta, "choice");
  const wrap = el("div", "tug-wrap");
  const track = el("div", "tug-track");
  const marker = el("div", "tug-marker");
  wrap.append(track, marker);
  const labels = el("div", "tug-labels");
  writeChoiceLabels(labels, meta.options, null);
  writeSlabs(track, idleShares(meta.options));
  visual.append(wrap, labels);
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", "1");

  return {
    root,
    setPhase(phase, judgment) {
      const reading = judgment?.kind === "choice" ? judgment : undefined;
      setConfidence(root, phase, reading?.confidence ?? null);
      if (phase === "idle" || phase === "error" || !reading) {
        writeSlabs(track, idleShares(meta.options));
        marker.style.opacity = "0";
        writeChoiceLabels(labels, meta.options, null);
        meter.removeAttribute("aria-valuenow");
        meter.removeAttribute("aria-valuetext");
        return;
      }
      writeSlabs(
        track,
        reading.options.map((opt) => opt.probability),
      );
      writeChoiceLabels(labels, reading.options, reading.choice);
      const t = choiceMarker(reading.options);
      marker.style.left = `${t * 100}%`;
      marker.style.opacity = "1";
      meter.setAttribute("aria-valuenow", String(t));
      const picked = reading.options.find((opt) => opt.id === reading.choice);
      meter.setAttribute("aria-valuetext", picked?.label ?? reading.choice);
    },
  };
}

function panel(
  meta: CriterionMeta,
  kind: CriterionKind,
): { root: HTMLElement; meter: HTMLElement; visual: HTMLElement } {
  const root = el("article", "gauge");
  root.dataset.kind = kind;
  root.dataset.phase = "idle";
  const title = el("h2", "gauge-label", meta.label);
  const meter = el("div", "visual");
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-label", meta.label);
  root.append(title, meter);
  return { root, meter, visual: meter };
}

function setConfidence(root: HTMLElement, phase: GaugePhase, confidence: number | null): void {
  root.dataset.phase = phase;
  if (confidence === null || phase === "idle" || phase === "error") {
    root.style.setProperty("--emphasis", "0");
    root.style.setProperty("--wobble", "0");
    return;
  }
  root.style.setProperty("--emphasis", String(confidence));
  root.style.setProperty("--wobble", String(1 - confidence));
}

function writeLabels(host: HTMLElement, levels: string[]): void {
  host.replaceChildren(...levels.map((name) => el("span", "level-name", name)));
}

function writeEqualSegs(host: HTMLElement, probabilities: number[]): void {
  host.replaceChildren(
    ...probabilities.map((p) => {
      const seg = el("span", "bar-seg");
      seg.style.opacity = String(0.18 + 0.72 * p);
      return seg;
    }),
  );
}

function writeChoiceLabels(host: HTMLElement, options: NamedOption[], chosen: string | null): void {
  host.replaceChildren(
    ...options.map((opt) => {
      const node = el("span", "tug-name", opt.label);
      if (chosen !== null && opt.id === chosen) node.dataset.chosen = "true";
      return node;
    }),
  );
}

function writeSlabs(host: HTMLElement, shares: number[]): void {
  const parts = shares.length > 0 ? shares : [1];
  host.replaceChildren(
    ...parts.map((share, i) => {
      const slab = el("span", "tug-slab");
      slab.style.flexGrow = String(Math.max(share, 0.0001));
      slab.dataset.slot = String(i % 2);
      return slab;
    }),
  );
}

function idleShares(options: NamedOption[]): number[] {
  if (options.length === 0) return [1, 1];
  return options.map(() => 1);
}

function choiceMarker(options: { probability: number }[]): number {
  const span = Math.max(options.length - 1, 1);
  const expected = options.reduce((sum, opt, i) => sum + opt.probability * i, 0);
  return clamp01(expected / span);
}

function nearestLevel(reading: ScoreCriterion): string {
  const i = Math.min(reading.levels.length - 1, Math.max(0, Math.round(reading.score)));
  return reading.levels[i] ?? reading.label;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
