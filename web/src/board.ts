import { fetchCriteria, JudgeError, judgeText, ParseError } from "./api.ts";
import type { JudgeResponse, JudgedCriterion } from "./api.ts";
import { createGauges, type GaugePhase } from "./gauges.ts";

const DEBOUNCE_MS = 280;

type Session = {
  token: number;
  timer: number;
  abort: AbortController | null;
  composing: boolean;
  last: JudgeResponse | null;
  gauges: ReturnType<typeof createGauges> | null;
};

export function mountBoard(root: HTMLElement): void {
  root.innerHTML = `
    <div class="board" data-phase="idle">
      <header class="top">
        <div class="titles">
          <h1>ライブ判定</h1>
          <p class="hint">文章を入れる。判定が出る。チャットではない。</p>
        </div>
        <p class="badge" hidden></p>
      </header>
      <textarea class="script" rows="6" maxlength="4000" aria-label="判定する文章"></textarea>
      <p class="notice" role="status" aria-live="polite"></p>
      <section class="gauges" aria-label="判定"></section>
    </div>
  `;

  const board = root.querySelector(".board");
  const textarea = root.querySelector(".script");
  const notice = root.querySelector(".notice");
  const gaugesHost = root.querySelector(".gauges");
  const badge = root.querySelector(".badge");
  if (
    !(board instanceof HTMLElement) ||
    !(textarea instanceof HTMLTextAreaElement) ||
    !(notice instanceof HTMLElement) ||
    !(gaugesHost instanceof HTMLElement) ||
    !(badge instanceof HTMLElement)
  ) {
    throw new Error("board markup missing");
  }
  const gaugesMount: HTMLElement = gaugesHost;

  const session: Session = {
    token: 0,
    timer: 0,
    abort: null,
    composing: false,
    last: null,
    gauges: null,
  };

  const schedule = (): void => {
    const text = textarea.value;
    if (text.trim() === "") {
      window.clearTimeout(session.timer);
      session.abort?.abort();
      session.token += 1;
      session.last = null;
      paint("idle", []);
      return;
    }
    window.clearTimeout(session.timer);
    session.timer = window.setTimeout(() => {
      void run(text);
    }, DEBOUNCE_MS);
  };

  const run = async (text: string): Promise<void> => {
    session.abort?.abort();
    const abort = new AbortController();
    session.abort = abort;
    const token = (session.token += 1);
    paint("judging", session.last?.criteria ?? [], session.last?.source ?? null);
    try {
      const result = await judgeText(text, abort.signal);
      if (token !== session.token) return;
      session.last = result;
      paint("ready", result.criteria, result.source);
    } catch (error) {
      if (token !== session.token) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      session.last = null;
      paint("error", [], null, messageOf(error));
    }
  };

  const paint = (
    phase: GaugePhase,
    judgments: readonly JudgedCriterion[],
    source: JudgeResponse["source"] | null = null,
    message = "",
  ): void => {
    board.dataset.phase = phase;
    session.gauges?.setPhase(phase, judgments);
    notice.textContent = message;
    notice.role = phase === "error" ? "alert" : "status";
    if (source === null) {
      badge.hidden = true;
      badge.textContent = "";
      delete badge.dataset.source;
      return;
    }
    badge.hidden = false;
    badge.dataset.source = source;
    badge.textContent = source === "live" ? "LIVE" : "DEMO";
  };

  textarea.addEventListener("compositionstart", () => {
    session.composing = true;
  });
  textarea.addEventListener("compositionend", () => {
    session.composing = false;
    schedule();
  });
  textarea.addEventListener("input", () => {
    // Japanese IME fires input before the character is committed.
    if (!session.composing) schedule();
  });

  void boot();

  async function boot(): Promise<void> {
    try {
      session.gauges = createGauges(await fetchCriteria());
      gaugesMount.replaceWith(session.gauges.root);
      paint("idle", []);
    } catch (error) {
      paint("error", [], null, messageOf(error));
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof JudgeError || error instanceof ParseError) return error.message;
  return "接続できませんでした。";
}
