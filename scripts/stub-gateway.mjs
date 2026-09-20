import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 8799);

function unitInterval(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function answerFor(id, question) {
  if (question.type === "boolean") return booleanAnswer(id);
  if (question.type === "score") return scoreAnswer(id, question.criteria.length);
  if (question.type === "choice") return choiceAnswer(id, Object.keys(question.criteria));
  return null;
}

function booleanAnswer(id) {
  return { type: "boolean", probability: round2(0.05 + unitInterval(id) * 0.9) };
}

function scoreAnswer(id, levels) {
  const weights = [];
  let total = 0;
  for (let i = 0; i < levels; i += 1) {
    const weight = round2(unitInterval(`${id}:${i}`));
    weights.push(weight);
    total += weight;
  }
  const probabilities = {};
  let score = 0;
  for (let i = 0; i < levels; i += 1) {
    probabilities[String(i)] = round2(weights[i] / total);
    score += i * probabilities[String(i)];
  }
  return { type: "score", score: round2(score), probabilities };
}

function choiceAnswer(id, keys) {
  const weights = {};
  let total = 0;
  for (const key of keys) {
    weights[key] = round2(unitInterval(`${id}:${key}`));
    total += weights[key];
  }
  const probabilities = {};
  let choice = keys[0];
  for (const key of keys) {
    probabilities[key] = round2(weights[key] / total);
    if (probabilities[key] > probabilities[choice]) choice = key;
  }
  return { type: "choice", choice, probabilities };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function evaluateBody(raw) {
  const request = JSON.parse(raw);
  return {
    model: request.model ?? "typesafe-ai/jev",
    answers: answersOf(request),
    usage: { inputTokens: raw.length, outputTokens: 0 },
    providerMetadata: {
      gateway: { cost: "0.00001155", generationId: "gen_stub" },
      typesafe: { confidence: confidenceOf(request) },
    },
  };
}

function answersOf(request) {
  const answers = {};
  for (const [id, question] of Object.entries(request.questions ?? {})) {
    const answer = answerFor(id, question);
    if (answer) answers[id] = answer;
  }
  return answers;
}

function confidenceOf(request) {
  const confidence = {};
  for (const [id, question] of Object.entries(request.questions ?? {})) {
    addConfidence(confidence, id, question);
  }
  return confidence;
}

function addConfidence(confidence, id, question) {
  if (question.type === "boolean") return;
  if (!answerFor(id, question)) return;
  confidence[id] = round2(0.3 + unitInterval(`c:${id}`) * 0.65);
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/v1/evaluate")) {
    sendJson(res, 404, { error: { message: "not found", param: null, type: "invalid_request_error" } });
    return;
  }

  if (!req.headers.authorization?.startsWith("Bearer ")) {
    sendJson(res, 401, {
      error: { message: "Authentication failed", param: null, type: "authentication_error" },
    });
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    try {
      sendJson(res, 200, evaluateBody(raw));
    } catch {
      sendJson(res, 400, { error: { message: "bad json", param: null, type: "invalid_request_error" } });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`stub-gateway listening on http://127.0.0.1:${PORT}\n`);
});
