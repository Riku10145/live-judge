export type CriterionKind = "boolean" | "score" | "choice";
export type Source = "live" | "demo";

export type CriterionMeta =
  | { kind: "boolean"; id: string; label: string }
  | { kind: "score"; id: string; label: string; levels: string[] }
  | { kind: "choice"; id: string; label: string; options: NamedOption[] };

export type NamedOption = { id: string; label: string };

export type BooleanCriterion = {
  kind: "boolean";
  id: string;
  label: string;
  probability: number;
  confidence: number;
};

export type ScoreCriterion = {
  kind: "score";
  id: string;
  label: string;
  score: number;
  levels: string[];
  probabilities: number[];
  confidence: number;
};

export type ChoiceOption = NamedOption & { probability: number };

export type ChoiceCriterion = {
  kind: "choice";
  id: string;
  label: string;
  choice: string;
  options: ChoiceOption[];
  confidence: number;
};

export type JudgedCriterion = BooleanCriterion | ScoreCriterion | ChoiceCriterion;

export type JudgeResponse = {
  source: Source;
  criteria: JudgedCriterion[];
};

export class ParseError extends Error {
  constructor() {
    super("応答の形が違います。");
    this.name = "ParseError";
  }
}

export class JudgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JudgeError";
    this.code = code;
  }
}

export async function fetchCriteria(signal?: AbortSignal): Promise<CriterionMeta[]> {
  const { res, data } = await requestJson("/api/criteria", { signal });
  throwIfEnvelope(data);
  if (!res.ok) throw new ParseError();
  return parseCriteriaResponse(data);
}

export async function judgeText(text: string, signal?: AbortSignal): Promise<JudgeResponse> {
  const { res, data } = await requestJson("/api/judge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  throwIfEnvelope(data);
  if (!res.ok) throw new ParseError();
  return parseJudgeResponse(data);
}

export function parseCriteriaResponse(data: unknown): CriterionMeta[] {
  const rec = asRecord(data);
  return asArray(rec.criteria).map((item) => parseMeta(item));
}

export function parseJudgeResponse(data: unknown): JudgeResponse {
  const rec = asRecord(data);
  const source = rec.source;
  if (source !== "live" && source !== "demo") malformed();
  const criteria = asArray(rec.criteria).map((item) => parseJudged(item));
  return { source, criteria };
}

async function requestJson(
  url: string,
  init: RequestInit,
): Promise<{ res: Response; data: unknown }> {
  const res = await fetch(url, { cache: "no-store", ...init });
  let data: unknown;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new ParseError();
  }
  return { res, data };
}

function throwIfEnvelope(data: unknown): void {
  if (!isRecord(data) || !("error" in data)) return;
  const error = asRecord(data.error);
  throw new JudgeError(asString(error.code), asString(error.message));
}

function parseMeta(data: unknown): CriterionMeta {
  const rec = asRecord(data);
  const id = asString(rec.id);
  const label = asString(rec.label);
  const kind = asKind(rec.kind);
  if (kind === "boolean") return { kind, id, label };
  if (kind === "score") {
    const levels = rec.levels === undefined ? [] : asStringList(rec.levels);
    return { kind, id, label, levels };
  }
  const options = rec.options === undefined ? [] : asArray(rec.options).map((item) => parseNamed(item));
  return { kind, id, label, options };
}

function parseJudged(data: unknown): JudgedCriterion {
  const rec = asRecord(data);
  const id = asString(rec.id);
  const label = asString(rec.label);
  const kind = asKind(rec.kind);
  const confidence = asUnit(rec.confidence);
  if (kind === "boolean") {
    return { kind, id, label, probability: asUnit(rec.probability), confidence };
  }
  if (kind === "score") {
    const levels = asStringList(rec.levels);
    if (levels.length === 0) malformed();
    const probabilities = asUnitList(rec.probabilities);
    if (probabilities.length !== levels.length) malformed();
    return { kind, id, label, score: asFinite(rec.score), levels, probabilities, confidence };
  }
  const choice = asString(rec.choice);
  const options = asArray(rec.options).map((item) => parseChoiceOption(item));
  if (options.length === 0) malformed();
  if (!options.some((opt) => opt.id === choice)) malformed();
  return { kind, id, label, choice, options, confidence };
}

function parseNamed(data: unknown): NamedOption {
  const rec = asRecord(data);
  return { id: asString(rec.id), label: asString(rec.label) };
}

function parseChoiceOption(data: unknown): ChoiceOption {
  const rec = asRecord(data);
  return { id: asString(rec.id), label: asString(rec.label), probability: asUnit(rec.probability) };
}

function asKind(value: unknown): CriterionKind {
  if (value === "boolean" || value === "score" || value === "choice") return value;
  return malformed();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : malformed();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : malformed();
}

function asString(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : malformed();
}

function asStringList(value: unknown): string[] {
  return asArray(value).map((item) => asString(item));
}

function asFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : malformed();
}

function asUnit(value: unknown): number {
  const n = asFinite(value);
  return n >= 0 && n <= 1 ? n : malformed();
}

function asUnitList(value: unknown): number[] {
  return asArray(value).map((item) => asUnit(item));
}

function malformed(): never {
  throw new ParseError();
}
