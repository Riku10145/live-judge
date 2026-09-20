# live-judge

ライブ判定ボード. You type one line of Japanese. A Rust server sends it to
[`typesafe-ai/jev`](https://vercel.com/ai-gateway/models/jev) through Vercel AI
Gateway, and the board renders the typed answers as live visuals.

Nothing here generates prose. jev is an evaluation model, so it answers typed
questions with probabilities instead of writing text. The board reads those
probabilities directly.

Three axes ship today.

| criterion | question type | panel |
| --- | --- | --- |
| 前向きさ | `boolean` | swing meter |
| 強度 | `score` | segmented bar |
| ネタ / 本気 | `choice` | tug-of-war |

## Certainty drives the visuals

Every verdict carries a `certainty` in `[0, 1]`, and one number drives emphasis
across all three panel types. A confident verdict is saturated, crisp and still.
An ambiguous one desaturates, softens and wobbles. Panels stay comparable
because a single formula produces the number.

That formula is the concentration of the answer's probability distribution,
measured as its normalized Euclidean distance from uniform over `n` outcomes.

```
concentration(q) = sqrt( Σ (qᵢ - 1/n)² / (1 - 1/n) )
```

A boolean answer only reports `probability`, so the server builds `[p, 1-p]`
first. At `n = 2` the formula reduces exactly to `|2p - 1|`, which is why
booleans need no separate rule. A coin flip gives `0` and a sure answer gives
`1`. For `score` and `choice` the server prefers the gateway's own
`providerMetadata.typesafe.confidence` and falls back to the same formula over
`probabilities`.

Normalized entropy, `1 - H/ln n`, was the other candidate. It loses on all three
counts that matter here. It does not reduce to `|2p - 1|`, so booleans would
need their own rule. It reads a 0.98 probability as 0.86 certain, while anyone
looking at that panel reads it as near certain. And it needs a `0 · ln 0` guard
that the Euclidean form does not.

## Requirements

- Rust 1.98.1. `rust-toolchain.toml` pins it, so `rustup` installs it for you.
- [Vite+](https://viteplus.dev). Install `vp` with `curl -fsSL https://vite.plus | bash`,
  then open a new shell.

## Setup

Copy the example environment file and fill in your key.

```bash
cp .env.example .env
```

| variable | default | meaning |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | unset | Vercel AI Gateway bearer token. Unset means demo mode. |
| `JEV_MODEL` | `typesafe-ai/jev` | Evaluation model id. Any AI Gateway model with the Evaluation capability works. |
| `AI_GATEWAY_BASE_URL` | `https://ai-gateway.vercel.sh` | Gateway origin. Point it at a stub to test without a key. |
| `LIVE_JUDGE_ADDR` | `127.0.0.1:8787` | Address the server binds to. |
| `WEB_DIST` | `web/dist` | Built frontend to serve at `/`. Skipped when the directory is missing. |
| `JEV_TIMEOUT_MS` | `15000` | Timeout for one gateway call. |
| `RUST_LOG` | `live_judge_server=info,tower_http=warn` | tracing filter. |

`AI_GATEWAY_API_KEY` is the only secret. Create one in the Vercel dashboard
under AI Gateway, then API Keys. `.env` is gitignored, and no key is committed
anywhere in this repository.

### Demo mode

The board runs with no key at all. When `AI_GATEWAY_API_KEY` is unset the server
answers with deterministic local verdicts derived from the text, marks the
response `"source": "demo"`, and the UI shows a badge saying so. Every panel,
animation and certainty calculation is the same code path as live judging. Only
the answers are local.

## Run it

Two processes during development, so the frontend keeps hot module replacement.

```bash
# terminal 1
cd server && cargo run

# terminal 2
cd web && vp install && vp dev
```

Open the URL `vp dev` prints. The Vite dev server proxies `/api` to the Rust
server on port 8787.

One process for a production-shaped run, where the server also serves the built
frontend.

```bash
cd web && vp install && vp build
cd ../server && cargo run
```

Open <http://127.0.0.1:8787>. If `WEB_DIST` points at a missing directory, the
server also looks in `../web/dist`, so `cargo run` from `server/` still serves
the build produced at the repository root.

## Add a criterion

Edit `server/src/criteria.rs`. That is the whole change.

```rust
Criterion {
    id: "sincerity",
    label: "本気度",
    blurb: "どこまで腹を括っているか",
    hue: 210,
    prompt: Prompt::Boolean {
        instructions: "この発言は本心から書かれているか。",
        true_label: "本心",
        false_label: "建前",
        true_criteria: "自分の言葉で、逃げ道を作らずに書いている",
        false_criteria: "社交辞令や決まり文句にとどまっている",
    },
}
```

A new panel appears with no frontend change. The prompt type alone selects the
renderer, so there is no `visual` field to keep in sync and no way to pair a
boolean question with a score bar. `web/src/panels.ts` only needs an edit when
you introduce a question type that jev supports and this board does not yet
render.

Questions are evaluated independently against the same text, so adding one does
not change the answers to the others.

## Verify

```bash
node scripts/verify.mjs
```

The script builds the server, starts a stub gateway from
`scripts/stub-gateway.mjs`, and drives the real HTTP surface. It checks the live
request path end to end, the typed failure when the gateway is unreachable, the
two input rejections, and demo mode including determinism. It needs no API key.

The per-language checks:

```bash
cd server && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test
cd web && vp check && vp test && vp build
```

[fallow](https://github.com/fallow-rs/fallow) gates the TypeScript for dead code,
duplication, complexity and styling drift. Run it from the repository root, since
`web/package.json` pins pnpm through `devEngines` and `npx` refuses to run under
that pin.

```bash
npx fallow audit web
```

## HTTP API

`GET /api/criteria` returns the registry, which is what the frontend renders
panels from.

`POST /api/judge` takes `{"text": "..."}` and returns verdicts keyed by criterion
id, alongside `source`, `model`, `elapsedMs` and token `usage`.

Failures return `{"error": {"kind": "...", "message": "..."}}`. The kinds are
`empty_text` and `text_too_long` with status 400, `gateway_auth`,
`gateway_unavailable` and `gateway_malformed` with status 502, and `timeout`
with status 504.

## Layout

```
server/src/criteria.rs   the registry, the one file you edit to add an axis
server/src/jev.rs        AI Gateway client, and the only place untrusted JSON is parsed
server/src/verdict.rs    pure certainty math and answer conversion, unit tested without network
server/src/demo.rs       deterministic offline verdicts
server/src/routes.rs     the two handlers and the typed error response
web/src/api.ts           the frontend's only boundary, parses responses into domain types
web/src/session.ts       judging lifecycle, drops stale responses
web/src/panels.ts        one renderer per prompt type
web/src/certainty.ts     certainty to CSS custom properties
scripts/verify.mjs       end-to-end check against a stub gateway
```
