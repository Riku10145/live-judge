export type Prompt =
  | { type: "boolean"; trueLabel: string; falseLabel: string }
  | { type: "score"; levels: string[] }
  | { type: "choice"; options: { key: string; label: string }[] };

export type Criterion = {
  id: string;
  label: string;
  blurb: string;
  hue: number;
  prompt: Prompt;
};

export type Verdict =
  | { type: "boolean"; probability: number; certainty: number }
  | { type: "score"; score: number; distribution: number[] | null; certainty: number }
  | {
      type: "choice";
      choice: string;
      distribution: Record<string, number> | null;
      certainty: number;
    };

export type Usage = {
  inputTokens: number;
  outputTokens: number;
};

export type Judgment = {
  source: "live" | "demo";
  model: string;
  elapsedMs: number;
  usage: Usage | null;
  verdicts: Record<string, Verdict>;
};

export type ErrorKind =
  | "empty_text"
  | "text_too_long"
  | "timeout"
  | "gateway_auth"
  | "gateway_unavailable"
  | "gateway_malformed"
  | "network"
  | "malformed";

export type JudgeError = {
  kind: ErrorKind;
  message: string;
};

export const ERROR_KINDS: readonly ErrorKind[] = [
  "empty_text",
  "text_too_long",
  "timeout",
  "gateway_auth",
  "gateway_unavailable",
  "gateway_malformed",
  "network",
  "malformed",
];
