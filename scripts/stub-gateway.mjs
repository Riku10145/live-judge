import http from 'node:http';

const PORT = Number(process.env.PORT ?? 18080);

const ANSWERS = {
  positivity: { type: 'boolean', probability: 0.82 },
  intensity: {
    type: 'score',
    score: 1.4,
    probabilities: { 0: 0.1, 1: 0.5, 2: 0.3, 3: 0.1 },
  },
  stance: {
    type: 'choice',
    choice: 'joke',
    probabilities: { joke: 0.7, serious: 0.3 },
  },
};

function sendError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      error: { message, param: null, type },
    }),
  );
}

function stateText(body) {
  if (typeof body.state === 'string') {
    return body.state;
  }
  if (body.state == null) {
    return '';
  }
  return JSON.stringify(body.state);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'POST' || url.pathname !== '/v1/evaluate') {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.headers.authorization !== 'Bearer test-key') {
    sendError(res, 401, 'authentication_error', 'Authentication failed');
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
      return;
    }

    if (stateText(body).includes('STUB_FAIL')) {
      sendError(res, 500, 'server_error', 'Internal error');
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'typesafe-ai/jev',
        answers: ANSWERS,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`stub-gateway listening on ${PORT}\n`);
});
