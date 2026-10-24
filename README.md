# fit-doctor

Diagnose and repair `.fit` files that Garmin Connect refuses to import — **entirely in your browser or on your own machine**.

**日本語は[下](#日本語)にあります。**

> FIT files contain GPS tracks, often of your home. fit-doctor never uploads your file: the web app runs fully client-side, ships a Content Security Policy that blocks all network requests (`connect-src 'none'`), and contains no analytics or tracking.

## What it fixes

### Mode A — collapsed summary end times (the main purpose)

In `lap`, `session`, `activity` and `time_in_zone` messages, `timestamp` (field 253) means the **end** of the interval. Some Garmin devices write the activity **start** time there instead. In the file this was built from (a Forerunner 970, 13-hour triathlon) all 86 laps, 5 sessions, the activity and all 91 `time_in_zone` messages carried the start time, so 85 of 86 laps ended before they began.

Garmin Connect derives durations from `start_time` and `timestamp`, so it rejects such a file. The file is still structurally valid, and the official Garmin SDK decodes it with zero errors. That is why existing tools miss it.

fit-doctor repairs a summary when `timestamp < start_time`, or when `timestamp == start_time` while `total_elapsed_time > 0`, and reports the two counts separately:

- lap / session: `start_time + round(total_elapsed_time / 1000)`
- activity: the latest session end; `local_timestamp` keeps its original offset from `timestamp`
- time_in_zone: the end of the lap/session it references (left alone if the reference cannot be resolved)

Values that are already plausible are never touched.

### Mode B — Connect rejects a structurally fine file (cause unknown)

Some files pass every structural and CRC check, and the official SDK reports zero errors, yet Garmin Connect says "an error occurred during upload". In one real case the upload succeeded after removing all of:

- `gps_metadata` (160) — 44,324 messages
- undefined message number 233 — 46,764 messages
- undefined message number 534 — 46,671 messages
- Connect IQ developer fields (`developer_data_id` 207, `field_description` 206, and the trailing developer bytes of every data message)

**Which of these removals actually made the difference was never isolated, and the root cause is unknown.** fit-doctor therefore offers each removal separately, so you can try them one at a time. Removing data is lossy; keep your original file.

## Design rule: byte-level edits only

fit-doctor never decodes and re-encodes a file. Real files contain many messages the public FIT profile does not define (in the validation file, 93,000 of 187,000 messages were numbers 233 and 534), and an SDK round trip would silently drop them. Every repair is either an in-place overwrite of specific bytes or the deletion of whole messages followed by recomputing `data size` and the CRCs. The Garmin SDK is used only in tests, to validate output.

## Usage

### Web

Open the site, drop a `.fit` file, choose repairs, download `<name>_repaired.fit`. English and Japanese are supported. Build locally with `npm run build -w @fit-doctor/web` (output in `apps/web/dist`).

### CLI

```bash
npm install
npm run build
npx fit-doctor diagnose activity.fit
npx fit-doctor repair activity.fit                          # timestamps only
npx fit-doctor repair activity.fit --strip-gps-metadata --no-timestamps
npx fit-doctor repair activity.fit --strip-all --dry-run
```

`repair` never overwrites an existing file without `--force`, and never overwrites its input. Exit codes: 0 success, 1 `diagnose` found errors, 2 failure. See `npx fit-doctor --help`.

### Library

`packages/core` has zero dependencies and uses only `Uint8Array`, so it runs in browsers and Node:

```ts
import { diagnose, repairTimestamps, stripMessages, stripDeveloperFields, recomputeCrc, parseStructure } from '@fit-doctor/core';
```

## How it compares

| Tool | What it does | Limits |
|---|---|---|
| Garmin `ActivityRepairTool.jar` | Repairs files whose recording was cut short, up to the point of corruption | Does nothing for structurally valid files |
| fitfiletools.com | Can remove message types | Requires uploading your file to a server |
| **fit-doctor** | Repairs the semantic field-253 problem; removes message types and developer fields; runs entirely in your browser | Mode B fixes are trial and error (see above) |

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

- `packages/core` — parser, CRC, diagnosis, repairs
- `packages/cli` — Node CLI
- `packages/fixtures` — synthetic FIT generator for tests. **Real activity files must never be committed** (they contain GPS coordinates); all test files are generated in code
- `apps/web` — Vite + TypeScript static site, deployed to GitHub Pages by `.github/workflows/pages.yml`

Tests validate every repair output with `@garmin/fitsdk`. The SDK cannot decode compressed-timestamp headers, so for those fixtures only its CRC integrity check is required. `@garmin/fitsdk` is used as an npm dev dependency under Garmin's own license and is not vendored. `packages/core/src/profile.ts` contains only message numbers and names, generated by `npm run gen:profile -w @fit-doctor/core`.

## License

MIT, see [LICENSE](LICENSE). The Garmin FIT SDK has its own license and is not included.

---

# 日本語

Garmin Connect にアップロードできない `.fit` ファイルを、**ブラウザ内（または手元のマシン上）だけで**診断・修復するツールです。

> FIT ファイルには、自宅周辺を含む GPS の軌跡が入っています。fit-doctor はファイルを一切アップロードしません。Web 版は完全にクライアント側で動き、外部通信をすべて遮断する CSP（`connect-src 'none'`）を付けて配信し、アナリティクスやトラッキングも入っていません。

## 直せる故障

### モードA：サマリーの終了時刻の潰れ（本ツールの主目的）

`lap` / `session` / `activity` / `time_in_zone` の `timestamp`（フィールド253）は区間の**終了**時刻の意味ですが、一部の Garmin デバイスがここにアクティビティの**開始**時刻を書いてしまいます。元になった実例（Forerunner 970、13時間のトライアスロン）では、86件の lap、5件の session、activity、91件の time_in_zone がすべて開始時刻になり、86件中85件の lap で「終了 < 開始」でした。

Garmin Connect は `start_time` と `timestamp` から所要時間を計算するため、このファイルを取り込めません。構造的には正常で、公式 SDK でもエラー0件になるため、既存ツールでは見つかりません。

`timestamp < start_time`、または `timestamp == start_time` かつ `total_elapsed_time > 0` のものを修復し、2つの件数は別々に報告します。

- lap / session：`start_time + round(total_elapsed_time / 1000)`
- activity：最後の session の終了時刻。`local_timestamp` は元の UTC オフセットを維持
- time_in_zone：参照先の lap / session の終了時刻（参照を解決できないものは変更しません）

すでに正しい値には触れません。

### モードB：構造的に正常なのに Connect が拒否する（原因未特定）

構造もCRCも正常で、公式 SDK がエラー0件と判定するのに、Garmin Connect が「アップロード中にエラーが発生しました」と表示するファイルがあります。実例では、次をすべて除去したところ取り込めました。

- `gps_metadata` (160)：44,324件
- 未定義メッセージ番号 233：46,764件
- 未定義メッセージ番号 534：46,671件
- Connect IQ 開発者フィールド一式（`developer_data_id` 207、`field_description` 206、各データメッセージ末尾の開発者フィールドのバイト）

**このうちどの除去が効いたのかは切り分けられておらず、根本原因も分かっていません。** そのため除去は個別にオンオフでき、1つずつ試せます。除去は情報を失う操作なので、元のファイルは必ず残してください。

## 設計方針：バイトレベルの修正のみ

デコードして再エンコードすることは一切しません。実ファイルには公開プロファイルに定義のないメッセージが多数含まれ（検証ファイルでは全187,000件中93,000件が233と534）、SDK を通すと黙って欠落するためです。修復は、特定バイトの上書き、またはメッセージ単位の削除（その後 `data size` とCRCを再計算）だけです。Garmin SDK はテストでの出力検証にのみ使います。

## 使い方

- **Web**：サイトを開き、`.fit` をドロップして修復を選び、`<元の名前>_repaired.fit` をダウンロードします（日本語・英語対応）。
- **CLI**：`npm install && npm run build` のあと、`npx fit-doctor diagnose activity.fit` や `npx fit-doctor repair activity.fit --strip-all --dry-run` を実行します。既存ファイルは `--force` なしでは上書きせず、入力ファイル自体は決して上書きしません。
- **ライブラリ**：`packages/core` は依存ゼロで `Uint8Array` だけを扱うため、ブラウザと Node の両方で動きます。

## 既存ツールとの違い

| ツール | できること | 制限 |
|---|---|---|
| Garmin 公式 `ActivityRepairTool.jar` | 記録が途中で途切れて破損したファイルを、破損箇所まで修復 | 構造的に正常なファイルは対象外 |
| fitfiletools.com | メッセージ種別の除去 | サーバーへのアップロードが必要 |
| **fit-doctor** | フィールド253の意味的な修復、メッセージ種別と開発者フィールドの除去。すべてブラウザ内で完結 | モードBは試行錯誤になる（上記） |

## 開発

`npm ci` → `npm run typecheck` → `npm run build` → `npm test`。テストの FIT ファイルはすべてコード内で合成しており、**実在のアクティビティファイル（GPS 座標を含む）は絶対にコミットしないでください**。`@garmin/fitsdk` は npm の開発用依存として参照するだけで、同梱していません。

## ライセンス

MIT（[LICENSE](LICENSE)）。Garmin FIT SDK は独自ライセンスのため含めていません。
