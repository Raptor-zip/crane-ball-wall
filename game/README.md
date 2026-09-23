# ゆらしてピタッ / Swing & Stick

クレーンの台車を動かして、紐で吊ったボールを壁の向こうへ振り出し、ゾーンの上でピタッと止めるブラウザゲーム。
研究の最適制御（AI）が出した最短時間の解がゴーストとして隣を走り、プレイヤーはその AI のタイムを超える（王冠）ことを目指す。
全 18 面・今日の5球・挑戦状リンク・世界ランキング（Cloudflare Workers + D1、サーバー側で再シミュレーションして検証）。

仕様はすべて [GAME_DESIGN.md](./GAME_DESIGN.md) にある。ディレクトリ構成とファイルごとの担当（単一所有者）は §10.1、
モジュール間の契約（型）は §10.4 と `src/contracts.ts`、テストの合格基準は §10.7、マイルストーンは §11 を参照。

## 準備

- Node 24 と npm
- `npm ci`
- ブラウザテスト・E2E を動かすとき：`npx playwright install chromium firefox webkit`
  （Linux で WebKit に足りないライブラリがあれば `sudo npx playwright install-deps webkit`）
- AI ゴーストなどのデータ生成（`npm run ghosts` / `daily` / `fixtures`）は、リポジトリのルートで `uv` が使えること

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー（API なし、オフラインで動く）。デモページは `/dev/*.html` |
| `npm test` | 単体テスト（sim, data, core, input, store, ui, worker） |
| `npm run test:browser` | ブラウザテスト（chromium / firefox / webkit） |
| `npm run test:e2e` | `dist-test/` と単一 HTML をビルドして Playwright で E2E（下の「E2E」） |
| `npm run typecheck` / `npm run lint` | 型検査 / ESLint（`src/sim` の決定性の禁止規則を含む） |
| `npm run build` | 本番ビルド → `dist/` |
| `npm run build:single` | 単一 HTML → `dist-single/index.html`（ネットワークなし）と、その検査 |
| `npm run worker:dev` | ビルドしてから Worker をローカルで起動（ローカル D1、http://localhost:8787） |
| `npm run db:migrate:local` | ローカル D1 にマイグレーションを適用 |
| `npm run ghosts` / `npm run daily` / `npm run fixtures` | AI ゴースト / 日替わりプール / テスト用固定データを生成（Python） |
| `npm run daily -- --bisect` | 既存の日替わりプールのパーだけを、物理を変えずにキャンペーンと同じ二分探索で締め直す（§8.2。数時間かかる。`tools/.cache` が要る） |
| `npm run deploy` | `tools/check-epoch.mjs`（§7.5 の `DAILY_EPOCH` が未来ならここで止まる）→ 本番ビルド → `wrangler deploy` |

## Worker をローカルで動かす（`worker:dev`）

1. `.dev.vars` を作り、`DEV=1` を書く（`.gitignore` 済み。`wrangler dev` だけが読む）。
   ```sh
   printf 'DEV=1\n' > .dev.vars
   ```
   `DEV=1` で `/api/bench` が開く（§7.7）。本番の `wrangler.jsonc` の `vars` は `DEV: "0"` のまま。
2. 初回だけローカル D1 にマイグレーションを適用する：`npm run db:migrate:local`
3. `npm run worker:dev` → http://localhost:8787/ でゲームと API（`/api/boot` など）が同じオリジンで動く。
   データは `.wrangler/state` に残る。まっさらにしたいときはそのディレクトリを消して 2 からやり直す。

`/api/boot` は `DEV=1` のとき（`.dev.vars`）と localhost / 127.0.0.1 からのリクエストでは Cache API を使わない
（ローカルの Cache API は max-age を過ぎた応答を返し続けることがあったため）。送信したランは 30 秒のメモが切れれば boot に出る。
`npm test` の worker プロジェクトは `.dev.vars` があっても `DEV=0` で走る（`vitest.config.ts`）。

## スマホで見る

PC とスマホを同じ Wi-Fi につなぎ、LAN に公開して起動する。

```sh
npm run dev -- --host            # vite --host（API なし、「オフライン」チップが出る）
npm run worker:dev -- --ip 0.0.0.0   # ランキングも含めて見るとき（:8787）
```

表示される `http://<PC の LAN の IP>:5173/`（Worker は `:8787`）をスマホのブラウザで開く。
つながらないときは PC のファイアウォールでそのポートを許可する。
http（localhost 以外）では `navigator.share` やクリップボードが使えない端末があり、シェアはテキスト欄に切り替わる。

## E2E（`npm run test:e2e`）

Playwright の 3 つのプロジェクト（`playwright.config.ts`）：

| プロジェクト | 中身 |
|---|---|
| `e2e` | `tests/e2e/*.spec.ts`。`dist-test/` を `vite preview` で配り、`window.__YP_TEST__` で操作する（起動 < 2 s、1-1 の成功と PB、1-2 のクラッシュ、リトライ < 100 ms、オフライン、単一 HTML、タッチだけの操作、挑戦状、今日の5球） |
| `demo` | `render-demo.spec.ts`（O5）と `ui-screens.spec.ts`（O7）。開発サーバーの `/dev/*.html` |
| `worker` | `worker.spec.ts`。本番ビルドを一時ディレクトリに作り、`wrangler dev`（使い捨てのローカル D1）で boot → 送信 → ランキングまで通す |

スクリーンショットは `test-results/e2e-shots/` に残る。何人か（何エージェントか）で同じ作業ツリーから同時に動かすときは、
ポートと出力先を環境変数で分ける：

```sh
PW_PREVIEW_PORT=4606 PW_DEV_PORT=5606 PW_WORKER_PORT=8606 \
YP_DIST_TEST=/tmp/me/dist-test YP_DIST_SINGLE=/tmp/me/dist-single PW_OUTPUT_DIR=/tmp/me/test-results \
npm run test:e2e -- --project e2e --project worker
```

| 変数 | 既定 | 内容 |
|---|---|---|
| `PW_PREVIEW_PORT` / `PW_DEV_PORT` | 4273 / 5273 | preview / 開発サーバーのポート |
| `PW_WORKER_PORT` | preview + 4000 | `worker.spec.ts` の `wrangler dev` |
| `YP_DIST_TEST` / `YP_DIST_SINGLE` | `dist-test` / `dist-single` | ビルドの出力先（`vite.config.ts` と `check-single.mjs` も読む） |
| `YP_E2E_WORKER_DIR` | OS の一時ディレクトリ | `worker.spec.ts` のビルドと D1 |
| `PW_OUTPUT_DIR` | `test-results` | Playwright の出力（実行のたびに空にされる） |
| `PW_SERVERS` | `preview,dev` | 起動するサーバー（`preview` / `dev` / `none`） |
| `PW_WORKERS` | `25%` | 並列数（1 ページごとに WebGL を CPU で描くので控えめ） |
| `PW_CHROME_ARGS` | なし | Chromium の追加フラグ |

ヘッドレス Chromium は WebGL をソフトウェア（SwiftShader）で描くので、最初のフレーム（シェーダーのコンパイル）が
2〜5 秒かかる。「最初の描画 < 2 s」と「入力 → 次のフレーム < 100 ms」はハードウェアの GL のときだけ厳密に検査し、
SwiftShader では値を記録するだけにしている。GPU がある機械では次のように付けると厳密な検査になる：
`PW_CHROME_ARGS="--enable-gpu --use-angle=vulkan --ignore-gpu-blocklist"`

## デプロイ（Cloudflare 無料枠）

1. `npx wrangler d1 create yurapita` の出力の `database_id` を `wrangler.jsonc` に書く
2. `npm run db:migrate:remote`
3. `VITE_PUBLIC_ORIGIN=https://<公開する URL> npm run deploy`
   （`VITE_PUBLIC_ORIGIN` を付けると共有リンクの URL と `og:image` / `og:url` がその絶対 URL になる。§7.13）

公開前に `src/shared/daily.ts` の `DAILY_EPOCH` が公開日以前であることを確かめる（§7.5）。
管理用の削除手順は `package.json` の `admin:purge` と `"//"` の項目にある。
