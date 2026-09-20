# live-judge

ライブ判定ボード。テキストを入れると、サーバーが AI Gateway 経由で `typesafe-ai/jev` の `evaluate` を呼び、前向きさ、強度、ネタと本気をゲージで出す。チャットではない。文章は生成しない。

## 動かし方

次の環境変数を使う。値はリポジトリに置かない。`.env.example` を見てシェルで export する。サーバーは `.env` ファイルを読まない。

- `AI_GATEWAY_API_KEY` ライブ判定用。未設定ならデモ判定になる。
- `AI_GATEWAY_URL` 省略時は `https://ai-gateway.vercel.sh`
- `LIVE_JUDGE_DEMO` `1` ならキーがあってもデモにする
- `PORT` サーバーの待ち受け。省略時は `8080`
- `STATIC_DIR` 省略可。`web` の build 出力を同じプロセスから配る

サーバーを起動する。

```sh
cd server
cargo run
```

ボードを起動する。

```sh
cd web
pnpm install
pnpm dev
```

ブラウザで Vite が出した URL を開く。`/api` と `/health` は `http://127.0.0.1:8080` にプロキシする。

キーなしで HTTP 経路を確認する。

```sh
node scripts/verify.mjs
```

TypeScript の変更は `fallow audit --base origin/main web` で見る。Fallow は静的解析 CLI であり、HTTP サーバーではない。
