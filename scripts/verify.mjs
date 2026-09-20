import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const stubPath = path.join(root, 'scripts', 'stub-gateway.mjs');
const children = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reservePorts(n) {
  return new Promise((resolve, reject) => {
    const servers = [];
    let opened = 0;
    for (let i = 0; i < n; i += 1) {
      const server = net.createServer();
      servers.push(server);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        opened += 1;
        if (opened === n) {
          const ports = servers.map((item) => item.address().port);
          let closed = 0;
          for (const item of servers) {
            item.close(() => {
              closed += 1;
              if (closed === n) {
                resolve(ports);
              }
            });
          }
        }
      });
    }
  });
}

function spawnLogged(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutBuf = '';
  child.stderrBuf = '';
  child.stdout.on('data', (chunk) => {
    child.stdoutBuf += chunk;
  });
  child.stderr.on('data', (chunk) => {
    child.stderrBuf += chunk;
  });
  child.on('exit', (code, signal) => {
    child.exitCode = code;
    child.exitSignal = signal;
  });
  children.push(child);
  return child;
}

function killChildren() {
  for (const child of children) {
    if (child.exitCode != null || child.killed) {
      continue;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}

process.on('exit', killChildren);
process.on('SIGINT', () => {
  killChildren();
  process.exit(1);
});
process.on('SIGTERM', () => {
  killChildren();
  process.exit(1);
});

function baseEnv() {
  const env = { ...process.env };
  delete env.AI_GATEWAY_API_KEY;
  delete env.AI_GATEWAY_URL;
  delete env.LIVE_JUDGE_DEMO;
  delete env.STATIC_DIR;
  return env;
}

async function waitForHealth(port, child, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(
        `server on ${port} exited ${child.exitCode}\n${child.stderrBuf}\n${child.stdoutBuf}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true) {
          return;
        }
      }
    } catch {
      // not listening yet
    }
    await delay(50);
  }
  throw new Error(
    `timed out waiting for health on ${port}\n${child.stderrBuf}\n${child.stdoutBuf}`,
  );
}

async function waitForStub(port, child, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`stub exited ${child.exitCode}\n${child.stderrBuf}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (response.status === 401) {
        return;
      }
    } catch {
      // not listening yet
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for stub on ${port}\n${child.stderrBuf}`);
}

async function getJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const body = await response.json();
  return { status: response.status, body };
}

async function postJudge(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const body = await response.json();
  return { status: response.status, body };
}

function collectCriteria(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectCriteria(item, out);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    if (typeof node.id === 'string' && typeof node.kind === 'string') {
      out.push(node);
    }
    for (const value of Object.values(node)) {
      collectCriteria(value, out);
    }
  }
  return out;
}

function inUnitInterval(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

async function main() {
  const build = spawnSync('cargo', ['build'], {
    cwd: serverDir,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    throw new Error('cargo build failed');
  }
  const bin = path.join(serverDir, 'target', 'debug', 'live-judge-server');
  const [stubPort, livePort, demoPort, wrongPort, unreachPort, closedPort] =
    await reservePorts(6);

  const stub = spawnLogged(process.execPath, [stubPath], {
    env: { ...process.env, PORT: String(stubPort) },
  });
  await waitForStub(stubPort, stub);

  const live = spawnLogged(bin, [], {
    env: {
      ...baseEnv(),
      PORT: String(livePort),
      AI_GATEWAY_URL: `http://127.0.0.1:${stubPort}`,
      AI_GATEWAY_API_KEY: 'test-key',
      RUST_LOG: 'error',
    },
  });
  const demo = spawnLogged(bin, [], {
    env: {
      ...baseEnv(),
      PORT: String(demoPort),
      RUST_LOG: 'error',
    },
  });
  const wrong = spawnLogged(bin, [], {
    env: {
      ...baseEnv(),
      PORT: String(wrongPort),
      AI_GATEWAY_URL: `http://127.0.0.1:${stubPort}`,
      AI_GATEWAY_API_KEY: 'wrong-key',
      RUST_LOG: 'error',
    },
  });
  const unreachable = spawnLogged(bin, [], {
    env: {
      ...baseEnv(),
      PORT: String(unreachPort),
      AI_GATEWAY_URL: `http://127.0.0.1:${closedPort}`,
      AI_GATEWAY_API_KEY: 'test-key',
      RUST_LOG: 'error',
    },
  });

  await Promise.all([
    waitForHealth(livePort, live),
    waitForHealth(demoPort, demo),
    waitForHealth(wrongPort, wrong),
    waitForHealth(unreachPort, unreachable),
  ]);

  const health = await getJson(livePort, '/health');
  assert(health.status === 200, `health status ${health.status}`);
  assert(health.body.ok === true, `health body ${JSON.stringify(health.body)}`);
  console.log('ok health');

  const criteria = await getJson(livePort, '/api/criteria');
  assert(criteria.status === 200, `criteria status ${criteria.status}`);
  const listed = collectCriteria(criteria.body);
  const byId = Object.fromEntries(listed.map((item) => [item.id, item]));
  assert(byId.positivity?.kind === 'boolean', 'criteria missing positivity boolean');
  assert(byId.intensity?.kind === 'score', 'criteria missing intensity score');
  assert(byId.stance?.kind === 'choice', 'criteria missing stance choice');
  console.log('ok criteria');

  const liveJudge = await postJudge(livePort, { text: '今日はいい天気だね。' });
  assert(liveJudge.status === 200, `live status ${liveJudge.status} ${JSON.stringify(liveJudge.body)}`);
  assert(liveJudge.body.source === 'live', `live source ${liveJudge.body.source}`);
  const liveCriteria = liveJudge.body.criteria;
  assert(Array.isArray(liveCriteria) && liveCriteria.length === 3, 'live expected three criteria');
  const liveById = Object.fromEntries(liveCriteria.map((item) => [item.id, item]));
  assert(liveById.positivity?.kind === 'boolean', 'live positivity kind');
  assert(liveById.intensity?.kind === 'score', 'live intensity kind');
  assert(liveById.stance?.kind === 'choice', 'live stance kind');
  for (const item of liveCriteria) {
    assert(inUnitInterval(item.confidence), `${item.id} confidence ${item.confidence}`);
  }
  assert(
    inUnitInterval(liveById.positivity.probability),
    `boolean probability ${liveById.positivity.probability}`,
  );
  console.log('ok live-via-stub');

  const unreachableJudge = await postJudge(unreachPort, { text: '今日はいい天気だね。' });
  assert(
    unreachableJudge.status === 502,
    `unreachable status ${unreachableJudge.status} ${JSON.stringify(unreachableJudge.body)}`,
  );
  const unreachableCode = unreachableJudge.body?.error?.code;
  assert(
    unreachableCode === 'gateway_unreachable' || unreachableCode === 'gateway_error',
    `unreachable code ${unreachableCode}`,
  );
  console.log('ok unreachable-gateway');

  const empty = await postJudge(livePort, { text: '' });
  assert(empty.status === 400, `empty status ${empty.status}`);
  assert(empty.body?.error?.code === 'empty_text', `empty code ${empty.body?.error?.code}`);
  const whitespace = await postJudge(livePort, { text: ' \n\t ' });
  assert(whitespace.status === 400, `whitespace status ${whitespace.status}`);
  assert(
    whitespace.body?.error?.code === 'empty_text',
    `whitespace code ${whitespace.body?.error?.code}`,
  );
  console.log('ok empty-text');

  const tooLong = await postJudge(livePort, { text: 'あ'.repeat(4001) });
  assert(tooLong.status === 400, `too-long status ${tooLong.status}`);
  assert(
    tooLong.body?.error?.code === 'text_too_long',
    `too-long code ${tooLong.body?.error?.code}`,
  );
  console.log('ok text-too-long');

  const sample = { text: '同じ文を二度判定する。' };
  const demoFirst = await postJudge(demoPort, sample);
  const demoSecond = await postJudge(demoPort, sample);
  assert(demoFirst.status === 200, `demo first ${demoFirst.status} ${JSON.stringify(demoFirst.body)}`);
  assert(demoSecond.status === 200, `demo second ${demoSecond.status}`);
  assert(demoFirst.body.source === 'demo', `demo first source ${demoFirst.body.source}`);
  assert(demoSecond.body.source === 'demo', `demo second source ${demoSecond.body.source}`);
  assert(
    JSON.stringify(demoFirst.body) === JSON.stringify(demoSecond.body),
    'demo responses were not equal',
  );
  console.log('ok demo-determinism');

  const unauthorized = await postJudge(wrongPort, { text: '今日はいい天気だね。' });
  assert(
    unauthorized.status === 502,
    `wrong-key status ${unauthorized.status} ${JSON.stringify(unauthorized.body)}`,
  );
  assert(
    unauthorized.body?.error?.code === 'gateway_error',
    `wrong-key code ${unauthorized.body?.error?.code}`,
  );
  console.log('ok stub-401');

  console.log('all passed');
}

main()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    killChildren();
  });
