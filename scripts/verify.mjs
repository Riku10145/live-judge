import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUB_PORT = 8799;
const SERVER_PORT = 8788;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const SAMPLE = "このセット、本当に最高だった！";

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    process.stdout.write(`  pass  ${label}\n`);
    return true;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${label}${detail === undefined ? "" : ` (${detail})`}\n`);
  return false;
}

const children = [];

function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

process.on("exit", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

async function waitForHttp(url, child, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early with code ${child.exitCode}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`${label} did not become reachable at ${url}`);
}

async function startServer(env) {
  const server = launch(resolve(root, "server/target/debug/live-judge-server"), [], {
    env: {
      ...process.env,
      LIVE_JUDGE_ADDR: `127.0.0.1:${SERVER_PORT}`,
      AI_GATEWAY_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
      RUST_LOG: "live_judge_server=info",
      WEB_DIST: "web/dist",
      ...env,
    },
  });
  let log = "";
  server.stdout.on("data", (d) => {
    log += d;
  });
  server.stderr.on("data", (d) => {
    log += d;
  });
  await waitForHttp(`${BASE}/api/criteria`, server, "server");
  return {
    server,
    log: () => log,
    async stop() {
      server.kill("SIGTERM");
      await once(server, "exit");
    },
  };
}

async function judge(text) {
  const response = await fetch(`${BASE}/api/judge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return { status: response.status, body: await response.json() };
}

function isWiredCriterion(c) {
  return hasCopy(c) && hasHue(c) && hasPrompt(c);
}

function hasCopy(c) {
  return typeof c.id === "string" && typeof c.label === "string" && typeof c.blurb === "string";
}

function hasHue(c) {
  return Number.isInteger(c.hue) && c.hue >= 0 && c.hue < 360;
}

function hasPrompt(c) {
  return ["boolean", "score", "choice"].includes(c.prompt?.type);
}

function isProbability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

process.stdout.write("building server\n");
const build = launch("cargo", ["build"], { cwd: resolve(root, "server"), stdio: "inherit" });
const [buildCode] = await once(build, "exit");
if (buildCode !== 0) {
  process.stderr.write("cargo build failed\n");
  process.exit(1);
}

process.stdout.write("starting stub gateway\n");
const stub = launch("node", [resolve(root, "scripts/stub-gateway.mjs")], {
  env: { ...process.env, STUB_PORT: String(STUB_PORT) },
});
await waitForHttp(`http://127.0.0.1:${STUB_PORT}/v1/evaluate`, stub, "stub gateway");

process.stdout.write("\nlive path (stub gateway, key set)\n");
let running = await startServer({ AI_GATEWAY_API_KEY: "stub-key" });

const criteriaResponse = await fetch(`${BASE}/api/criteria`);
const { criteria } = await criteriaResponse.json();
check("GET /api/criteria returns 200", criteriaResponse.status === 200, criteriaResponse.status);
check("registry is non-empty", Array.isArray(criteria) && criteria.length > 0, criteria?.length);
check("every criterion carries id, label, blurb, hue and prompt", criteria.every(isWiredCriterion));
check(
  "all three prompt types are exercised",
  new Set(criteria.map((c) => c.prompt.type)).size === 3,
  [...new Set(criteria.map((c) => c.prompt.type))].join(","),
);
check(
  "no criterion carries a visual field (the prompt type selects the panel)",
  criteria.every((c) => c.visual === undefined),
);

const live = await judge(SAMPLE);
check("POST /api/judge returns 200", live.status === 200, live.status);
check("source is live", live.body.source === "live", live.body.source);
check("usage is reported", typeof live.body.usage?.inputTokens === "number");
check("elapsedMs is reported", typeof live.body.elapsedMs === "number" && live.body.elapsedMs >= 1, live.body.elapsedMs);
check(
  "every criterion received a verdict",
  criteria.every((c) => live.body.verdicts?.[c.id] !== undefined),
  Object.keys(live.body.verdicts ?? {}).join(","),
);
check(
  "verdict type matches its criterion's prompt type",
  criteria.every((c) => live.body.verdicts[c.id]?.type === c.prompt.type),
);
check(
  "every certainty is a probability",
  Object.values(live.body.verdicts ?? {}).every((v) => isProbability(v.certainty)),
  JSON.stringify(Object.fromEntries(Object.entries(live.body.verdicts ?? {}).map(([k, v]) => [k, v.certainty]))),
);

const scoreCriterion = criteria.find((c) => c.prompt.type === "score");
const scoreVerdict = live.body.verdicts[scoreCriterion.id];
check(
  "score distribution is dense and level-indexed",
  Array.isArray(scoreVerdict.distribution) && scoreVerdict.distribution.length === scoreCriterion.prompt.levels.length,
  `${scoreVerdict.distribution?.length} vs ${scoreCriterion.prompt.levels.length}`,
);
check(
  "score sits inside the zero-indexed rubric range",
  scoreVerdict.score >= 0 && scoreVerdict.score <= scoreCriterion.prompt.levels.length - 1,
  scoreVerdict.score,
);

const choiceCriterion = criteria.find((c) => c.prompt.type === "choice");
const choiceVerdict = live.body.verdicts[choiceCriterion.id];
check(
  "chosen option is one the registry declared",
  choiceCriterion.prompt.options.some((o) => o.key === choiceVerdict.choice),
  choiceVerdict.choice,
);
check(
  "chosen option holds the highest probability",
  !choiceVerdict.distribution ||
    Object.values(choiceVerdict.distribution).every((p) => p <= choiceVerdict.distribution[choiceVerdict.choice]),
  JSON.stringify(choiceVerdict.distribution),
);

const empty = await judge("   ");
check("whitespace-only text is rejected", empty.status === 400, empty.status);
check("rejection names its kind", empty.body.error?.kind === "empty_text", JSON.stringify(empty.body));

const tooLong = await judge("あ".repeat(2001));
check("over-long text is rejected", tooLong.status === 400, tooLong.status);
check("rejection names its kind", tooLong.body.error?.kind === "text_too_long", JSON.stringify(tooLong.body));

await running.stop();

process.stdout.write("\ngateway failure path (nothing listening)\n");
running = await startServer({
  AI_GATEWAY_API_KEY: "stub-key",
  AI_GATEWAY_BASE_URL: "http://127.0.0.1:8798",
});
const unreachable = await judge(SAMPLE);
check("unreachable gateway is a 502", unreachable.status === 502, unreachable.status);
check(
  "failure names its kind",
  unreachable.body.error?.kind === "gateway_unavailable",
  JSON.stringify(unreachable.body),
);
check(
  "failure carries no verdicts",
  unreachable.body.verdicts === undefined,
  JSON.stringify(unreachable.body.verdicts),
);
await running.stop();

process.stdout.write("\ndemo path (no key)\n");
running = await startServer({ AI_GATEWAY_API_KEY: "" });
const demo = await judge(SAMPLE);
check("POST /api/judge returns 200", demo.status === 200, demo.status);
check("source is demo", demo.body.source === "demo", demo.body.source);
check("elapsedMs is at least 1 ms", typeof demo.body.elapsedMs === "number" && demo.body.elapsedMs >= 1, demo.body.elapsedMs);
check("usage is null in demo mode", demo.body.usage === null, JSON.stringify(demo.body.usage));
check(
  "every criterion still received a verdict",
  criteria.every((c) => demo.body.verdicts?.[c.id] !== undefined),
);
check(
  "every certainty is a probability",
  Object.values(demo.body.verdicts ?? {}).every((v) => isProbability(v.certainty)),
);

const repeat = await judge(SAMPLE);
check(
  "demo verdicts are deterministic for identical text",
  JSON.stringify(repeat.body.verdicts) === JSON.stringify(demo.body.verdicts),
);

const different = await judge("正直これはしんどい");
check(
  "demo verdicts change with the text",
  JSON.stringify(different.body.verdicts) !== JSON.stringify(demo.body.verdicts),
);

await running.stop();

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
