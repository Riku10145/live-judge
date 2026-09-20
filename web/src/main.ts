import "./style.css";
import { judgeText, loadCriteria } from "./api.ts";
import { mountBoard, paintBoard } from "./panels.ts";
import { Session, isJudgeError } from "./session.ts";
import {
  ERROR_KINDS,
  type Criterion,
  type ErrorKind,
  type JudgeError,
  type Judgment,
  type Verdict,
} from "./types.ts";

const SEED = "このセット、本当に最高だった！";

const KIND_COPY: Record<ErrorKind, string> = {
  empty_text: "文が空です。",
  text_too_long: "文が長すぎます。2000字以内にしてください。",
  timeout: "判定が時間切れになりました。",
  gateway_auth: "AI Gateway の鍵を受け付けませんでした。",
  gateway_unavailable: "AI Gateway に届きませんでした。",
  gateway_malformed: "判定の返事の形が崩れています。",
  network: "サーバーに届きませんでした。",
  malformed: "返事を読めませんでした。",
};

const app = document.querySelector("#app");
if (!(app instanceof HTMLElement)) {
  throw new Error("#app is missing");
}

app.innerHTML = `
  <header class="mast">
    <p class="kicker">live-judge</p>
    <h1>ライブ判定ボード</h1>
    <p class="lede">一言を書くと、前向きさ・強度・ネタ本気が一気に出る。</p>
  </header>
  <section class="composer">
    <label class="field">
      <span>判定する文</span>
      <textarea id="text" rows="4" maxlength="2000">${SEED}</textarea>
    </label>
    <div class="composer-row">
      <button type="button" id="judge">判定</button>
      <p id="status" class="status" aria-live="polite"></p>
    </div>
    <p id="demo" class="banner demo" hidden>デモ判定です。AI_GATEWAY_API_KEY が未設定のため、結果は端末内で作っています。</p>
    <p id="error" class="banner error" hidden></p>
  </section>
  <section id="board" class="board"></section>
`;

const text = required("#text", HTMLTextAreaElement);
const judgeButton = required("#judge", HTMLButtonElement);
const status = required("#status", HTMLElement);
const demo = required("#demo", HTMLElement);
const errorStrip = required("#error", HTMLElement);
const board = required("#board", HTMLElement);

let criteria: Criterion[] = [];
try {
  criteria = await loadCriteria();
} catch (err: unknown) {
  showError(asError(err));
}

mountBoard(board, criteria);
paintBoard(board, criteria, null, false);

function renderPhase(phase: Session["phase"], previous: Judgment | null): void {
  const judged = judgedOf(phase, previous);
  paintBoard(board, criteria, verdictsOf(judged), isBusy(phase));
  demo.hidden = !isDemoSource(judged);
  syncError(phase);
  status.textContent = statusLine(phase, judged);
  judgeButton.disabled = isBusy(phase);
}

function verdictsOf(judged: Judgment | null): Record<string, Verdict> | null {
  if (!judged) return null;
  return judged.verdicts;
}

function isDemoSource(judged: Judgment | null): boolean {
  if (!judged) return false;
  return judged.source === "demo";
}

function judgedOf(phase: Session["phase"], previous: Judgment | null): Judgment | null {
  if (phase.kind === "judged") return phase.result;
  return previous;
}

function isBusy(phase: Session["phase"]): boolean {
  return phase.kind === "judging";
}

function syncError(phase: Session["phase"]): void {
  if (phase.kind !== "failed") {
    errorStrip.hidden = true;
    errorStrip.textContent = "";
    return;
  }
  showError(phase.error);
}

const session = new Session(judgeText, window, renderPhase);

text.addEventListener("input", () => session.type(text.value));
text.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    session.force(text.value);
  }
});
judgeButton.addEventListener("click", () => session.force(text.value));

session.force(text.value);

function statusLine(phase: { kind: string }, judged: Judgment | null): string {
  if (phase.kind === "judging") return "判定中";
  if (!judged) return "文を書くと判定します";
  return judgedLine(judged);
}

function judgedLine(judged: Judgment): string {
  if (!judged.usage) return `${judged.elapsedMs} ms ・ ${judged.model}`;
  return `${judged.elapsedMs} ms ・ ${judged.model} ・ ${judged.usage.inputTokens} token`;
}

function showError(error: JudgeError): void {
  errorStrip.hidden = false;
  errorStrip.textContent = KIND_COPY[error.kind];
}

function asError(value: unknown): JudgeError {
  if (!isJudgeError(value)) return { kind: "network", message: "criteria could not be loaded" };
  for (const known of ERROR_KINDS) {
    if (known === value.kind) return { kind: known, message: value.message };
  }
  return { kind: "network", message: value.message };
}

function required<T extends Element>(selector: string, ctor: new (...args: never[]) => T): T {
  const el = document.querySelector(selector);
  if (!(el instanceof ctor)) {
    throw new Error(`${selector} is missing`);
  }
  return el;
}
