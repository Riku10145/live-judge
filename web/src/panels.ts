import { applyCertainty } from "./certainty.ts";
import type { Criterion, Prompt, Verdict } from "./types.ts";

type Renderer<P extends Prompt, V extends Verdict> = (
  body: HTMLElement,
  prompt: P,
  verdict: V | null,
) => void;

const booleanPanel: Renderer<
  Extract<Prompt, { type: "boolean" }>,
  Extract<Verdict, { type: "boolean" }>
> = (body, prompt, verdict) => {
  const probability = verdict?.probability ?? 0.5;
  body.innerHTML = `
    <div class="meter">
      <div class="meter-arc" style="--needle: ${probability}"></div>
      <p class="meter-value">${pct(probability)}</p>
      <div class="meter-poles">
        <span>${escapeHtml(prompt.falseLabel)}</span>
        <span>${escapeHtml(prompt.trueLabel)}</span>
      </div>
    </div>
  `;
};

const scorePanel: Renderer<
  Extract<Prompt, { type: "score" }>,
  Extract<Verdict, { type: "score" }>
> = (body, prompt, verdict) => {
  const max = Math.max(1, prompt.levels.length - 1);
  const fill = verdict ? clamp(verdict.score / max, 0, 1) : 0;
  const distribution = verdict?.distribution;
  const segments = prompt.levels
    .map((label, index) => {
      const weight = distribution?.[index] ?? 0;
      return `<div class="seg" style="--mass: ${weight}"><span>${escapeHtml(label)}</span></div>`;
    })
    .join("");
  body.innerHTML = `
    <div class="bar">
      <div class="bar-track">
        <div class="bar-fill" style="--fill: ${fill}"></div>
        <div class="bar-segs">${segments}</div>
      </div>
      <p class="bar-value">${verdict ? verdict.score.toFixed(2) : "—"} / ${max}</p>
    </div>
  `;
};

const choicePanel: Renderer<
  Extract<Prompt, { type: "choice" }>,
  Extract<Verdict, { type: "choice" }>
> = (body, prompt, verdict) => {
  const parts = prompt.options.map((option) => {
    const share = shareOf(option.key, prompt, verdict);
    const won = verdict?.choice === option.key;
    return `<div class="tug-opt${won ? " is-won" : ""}" style="--share: ${share}">
      <span>${escapeHtml(option.label)}</span>
      <strong>${pct(share)}</strong>
    </div>`;
  });
  body.innerHTML = `<div class="tug">${parts.join("")}</div>`;
};

export function mountBoard(host: HTMLElement, criteria: Criterion[]): void {
  host.replaceChildren();
  for (const criterion of criteria) {
    host.append(panelShell(criterion));
  }
}

export function paintBoard(
  host: HTMLElement,
  criteria: Criterion[],
  verdicts: Record<string, Verdict> | null,
  busy: boolean,
): void {
  host.classList.toggle("is-busy", busy);
  for (const criterion of criteria) {
    paintMounted(host, criterion, verdicts);
  }
}

function paintMounted(
  host: HTMLElement,
  criterion: Criterion,
  verdicts: Record<string, Verdict> | null,
): void {
  const panel = host.querySelector(`[data-id="${cssEscape(criterion.id)}"]`);
  if (!(panel instanceof HTMLElement)) return;
  paintPanel(panel, criterion, verdicts?.[criterion.id] ?? null);
}

function paintPanel(panel: HTMLElement, criterion: Criterion, verdict: Verdict | null): void {
  const slots = panelSlots(panel);
  if (!slots) return;
  fillPanel(slots, panel, criterion, verdict);
}

function panelSlots(panel: HTMLElement): { body: HTMLElement; readout: HTMLElement } | null {
  const body = panel.querySelector("[data-body]");
  const readout = panel.querySelector("[data-certainty]");
  if (!(body instanceof HTMLElement)) return null;
  if (!(readout instanceof HTMLElement)) return null;
  return { body, readout };
}

function fillPanel(
  slots: { body: HTMLElement; readout: HTMLElement },
  panel: HTMLElement,
  criterion: Criterion,
  verdict: Verdict | null,
): void {
  if (isTypeMismatch(criterion, verdict)) {
    slots.body.textContent = "型が合いません";
    applyCertainty(panel, null);
    slots.readout.textContent = "確度 —";
    return;
  }
  dispatch(slots.body, criterion.prompt, verdict);
  applyCertainty(panel, certaintyOf(verdict));
  slots.readout.textContent = certaintyLabel(verdict);
}

function certaintyOf(verdict: Verdict | null): number | null {
  if (!verdict) return null;
  return verdict.certainty;
}

function isTypeMismatch(criterion: Criterion, verdict: Verdict | null): boolean {
  return verdict !== null && verdict.type !== criterion.prompt.type;
}

function certaintyLabel(verdict: Verdict | null): string {
  if (!verdict) return "確度 —";
  return `確度 ${pct(verdict.certainty)}`;
}

function dispatch(body: HTMLElement, prompt: Prompt, verdict: Verdict | null): void {
  if (prompt.type === "boolean") {
    booleanPanel(body, prompt, booleanVerdict(verdict));
    return;
  }
  if (prompt.type === "score") {
    scorePanel(body, prompt, scoreVerdict(verdict));
    return;
  }
  choicePanel(body, prompt, choiceVerdict(verdict));
}

function booleanVerdict(verdict: Verdict | null): Extract<Verdict, { type: "boolean" }> | null {
  if (verdict?.type === "boolean") return verdict;
  return null;
}

function scoreVerdict(verdict: Verdict | null): Extract<Verdict, { type: "score" }> | null {
  if (verdict?.type === "score") return verdict;
  return null;
}

function choiceVerdict(verdict: Verdict | null): Extract<Verdict, { type: "choice" }> | null {
  if (verdict?.type === "choice") return verdict;
  return null;
}

function shareOf(
  key: string,
  prompt: Extract<Prompt, { type: "choice" }>,
  verdict: Extract<Verdict, { type: "choice" }> | null,
): number {
  if (!verdict) return 1 / prompt.options.length;
  return choiceShare(verdict, key);
}

function choiceShare(verdict: Extract<Verdict, { type: "choice" }>, key: string): number {
  if (verdict.distribution) return massAt(verdict.distribution, key);
  if (verdict.choice === key) return 1;
  return 0;
}

function massAt(distribution: Record<string, number>, key: string): number {
  const value = distribution[key];
  if (value === undefined) return 0;
  return value;
}

function panelShell(criterion: Criterion): HTMLElement {
  const article = document.createElement("article");
  article.className = "panel";
  article.dataset.id = criterion.id;
  article.style.setProperty("--hue", String(criterion.hue));
  article.innerHTML = `
    <header class="panel-head">
      <h2>${escapeHtml(criterion.label)}</h2>
      <p>${escapeHtml(criterion.blurb)}</p>
      <p class="certainty" data-certainty>確度 —</p>
    </header>
    <div class="panel-body" data-body></div>
  `;
  const body = article.querySelector("[data-body]");
  if (body instanceof HTMLElement) dispatch(body, criterion.prompt, null);
  return article;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cssEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
