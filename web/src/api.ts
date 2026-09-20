import {
  ERROR_KINDS,
  type Criterion,
  type ErrorKind,
  type JudgeError,
  type Judgment,
  type Prompt,
  type Verdict,
} from "./types.ts";

export async function loadCriteria(): Promise<Criterion[]> {
  const response = await fetch("/api/criteria");
  const raw: unknown = await readJson(response);
  const criteria = parseCriteria(raw);
  if (!criteria) {
    throw errorOf("malformed", "criteria response was not a registry");
  }
  return criteria;
}

export async function judgeText(text: string): Promise<Judgment> {
  let response: Response;
  try {
    response = await fetch("/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw errorOf("network", "the board could not reach the server");
  }

  const raw: unknown = await readJson(response);
  if (!response.ok) {
    throw parseError(raw) ?? errorOf("malformed", `judge failed with ${response.status}`);
  }
  const judgment = parseJudgment(raw);
  if (!judgment) {
    throw errorOf("malformed", "judge response was not a judgment");
  }
  return judgment;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw errorOf("malformed", "response was not JSON");
  }
}

function parseCriteria(raw: unknown): Criterion[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.criteria)) return null;
  const criteria: Criterion[] = [];
  for (const item of raw.criteria) {
    const criterion = parseCriterion(item);
    if (!criterion) return null;
    criteria.push(criterion);
  }
  return criteria;
}

export function parseJudgment(raw: unknown): Judgment | null {
  if (!isRecord(raw)) return null;
  if (raw.source !== "live" && raw.source !== "demo") return null;
  if (typeof raw.model !== "string") return null;
  if (!isFiniteNumber(raw.elapsedMs)) return null;
  if (!isRecord(raw.verdicts)) return null;

  const verdicts: Record<string, Verdict> = {};
  for (const [id, value] of Object.entries(raw.verdicts)) {
    const verdict = parseVerdict(value);
    if (!verdict) return null;
    verdicts[id] = verdict;
  }

  let usage: Judgment["usage"] = null;
  if (raw.usage !== null && raw.usage !== undefined) {
    if (
      !isRecord(raw.usage) ||
      !isFiniteNumber(raw.usage.inputTokens) ||
      !isFiniteNumber(raw.usage.outputTokens)
    ) {
      return null;
    }
    usage = { inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens };
  }

  return {
    source: raw.source,
    model: raw.model,
    elapsedMs: raw.elapsedMs,
    usage,
    verdicts,
  };
}

function parseError(raw: unknown): JudgeError | null {
  if (!isRecord(raw) || !isRecord(raw.error) || typeof raw.error.kind !== "string") return null;
  if (!isErrorKind(raw.error.kind)) return null;
  return {
    kind: raw.error.kind,
    message: typeof raw.error.message === "string" ? raw.error.message : raw.error.kind,
  };
}

function parseCriterion(raw: unknown): Criterion | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, "id");
  const label = readString(raw, "label");
  const blurb = readString(raw, "blurb");
  const hue = readHue(raw.hue);
  const prompt = parsePrompt(raw.prompt);
  if (!id || !label || !blurb || hue === null || !prompt) return null;
  return { id, label, blurb, hue, prompt };
}

function parsePrompt(raw: unknown): Prompt | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  if (raw.type === "boolean") return parseBooleanPrompt(raw);
  if (raw.type === "score") return parseScorePrompt(raw);
  if (raw.type === "choice") return parseChoicePrompt(raw);
  return null;
}

function parseBooleanPrompt(raw: Record<string, unknown>): Prompt | null {
  const trueLabel = readString(raw, "trueLabel");
  const falseLabel = readString(raw, "falseLabel");
  if (!trueLabel || !falseLabel) return null;
  return { type: "boolean", trueLabel, falseLabel };
}

function parseScorePrompt(raw: Record<string, unknown>): Prompt | null {
  if (!Array.isArray(raw.levels) || raw.levels.length < 2) return null;
  const levels: string[] = [];
  for (const level of raw.levels) {
    if (typeof level !== "string") return null;
    levels.push(level);
  }
  return { type: "score", levels };
}

function parseChoicePrompt(raw: Record<string, unknown>): Prompt | null {
  if (!Array.isArray(raw.options) || raw.options.length < 2) return null;
  const options: { key: string; label: string }[] = [];
  for (const option of raw.options) {
    const parsed = parseOption(option);
    if (!parsed) return null;
    options.push(parsed);
  }
  return { type: "choice", options };
}

function parseOption(raw: unknown): { key: string; label: string } | null {
  if (!isRecord(raw)) return null;
  const key = readString(raw, "key");
  const label = readString(raw, "label");
  if (!key || !label) return null;
  return { key, label };
}

function parseVerdict(raw: unknown): Verdict | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !isProbability(raw.certainty)) return null;
  if (raw.type === "boolean") return parseBooleanVerdict(raw);
  if (raw.type === "score") return parseScoreVerdict(raw);
  if (raw.type === "choice") return parseChoiceVerdict(raw);
  return null;
}

function parseBooleanVerdict(raw: Record<string, unknown>): Verdict | null {
  if (!isProbability(raw.probability) || !isProbability(raw.certainty)) return null;
  return { type: "boolean", probability: raw.probability, certainty: raw.certainty };
}

function parseScoreVerdict(raw: Record<string, unknown>): Verdict | null {
  if (!isFiniteNumber(raw.score) || !isProbability(raw.certainty)) return null;
  const distribution = readNumberList(raw.distribution);
  if (raw.distribution !== null && distribution === null) return null;
  return { type: "score", score: raw.score, distribution, certainty: raw.certainty };
}

function parseChoiceVerdict(raw: Record<string, unknown>): Verdict | null {
  if (typeof raw.choice !== "string" || !isProbability(raw.certainty)) return null;
  const distribution = readNumberRecord(raw.distribution);
  if (raw.distribution !== null && distribution === null) return null;
  return { type: "choice", choice: raw.choice, distribution, certainty: raw.certainty };
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function readHue(raw: unknown): number | null {
  if (!isFiniteNumber(raw) || raw < 0 || raw >= 360) return null;
  return raw;
}

function readNumberList(raw: unknown): number[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const values: number[] = [];
  for (const item of raw) {
    if (!isFiniteNumber(item)) return null;
    values.push(item);
  }
  return values;
}

function readNumberRecord(raw: unknown): Record<string, number> | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return null;
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isFiniteNumber(value)) return null;
    values[key] = value;
  }
  return values;
}

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw);
}

function isProbability(raw: unknown): raw is number {
  return isFiniteNumber(raw) && raw >= 0 && raw <= 1;
}

function isErrorKind(raw: string): raw is ErrorKind {
  for (const kind of ERROR_KINDS) {
    if (kind === raw) return true;
  }
  return false;
}

function errorOf(kind: ErrorKind, message: string): JudgeError {
  return { kind, message };
}
