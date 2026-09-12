# 実装計画書：家計簿のMCP化

対応要件: [requirements.md](requirements.md)  
対応設計: [design.md](design.md)  
作成日: 2026-09-11  
状態: Phase 3 complete / Phase 5 rollout in progress（Cloudflare認証・D1/KV作成・スキーマ適用・架空デモデータ投入・OAuth secrets設定・finance Workerデプロイ済み、実データ・root Worker有効化・実クライアント接続待ち）

## 1. 進め方

本件は、最初からMoney Forward MEの実データへ接続しない。デモデータ、手動CSV、実データの順に段階を分け、各段階でGo/No-Goを判断する。

フェーズ0の実データ関連の判断が未確定でも、外部サービス・実データ・本番D1を使わないフェーズ1のPoCは先行できる。OAuth、Geminiへの送信、Money ForwardのWeb自動操作は、該当フェーズへ進む前に判断を完了させる。

```text
前提決定
  ↓
デモデータでMCP PoC
  ↓
D1・照会ツール完成
  ↓
OAuth・外部MCP完成
  ↓
ふくちゃんへService Bindingで統合
  ↓
実データ同期
  ↓
並行比較・本番切り替え
```

## 2. 役割分担

| 項目 | AIが担当 | ユーザーが担当 |
|---|---|---|
| 要件・設計 | 文書作成、選択肢・リスク整理 | 未決事項の最終判断 |
| 実装 | exporter、D1スキーマ、MCP Worker、Service Binding、テスト | 実データの利用範囲を承認 |
| Money Forward ME | セットアップ手順、値を表示しない検証 | ログイン、OTP、利用条件の確認 |
| 1Password | 必要項目と権限の案内 | Service Account作成、秘密値の入力 |
| Cloudflare | 設定案、コード、確認コマンド | OAuth同意、課金・アカウント設定の承認 |
| 本番切り替え | 比較結果・ロールバック手順の提示 | Go/No-Go判断 |

Money Forward MEのパスワード、OTP、ブラウザセッション、金融明細の実値は、会話・ログ・Publicリポジトリへ表示しない。

## 3. ブランチとIssue管理

- 実装ブランチ案：`codex/finance-mcp`
- 実装コードのIssueは、着手時に`fukurose-jun02/fukuchan-app`へ新規作成する。
- 旧`fukuchan-knowledge#1`は要望の出典として参照し、実装完了時に新Issueへのリンクを残して整理する。
- Pull Requestはフェーズ単位で分割する。推奨は次の3本。

| PR | 内容 |
|---|---|
| PR-A | D1スキーマ、query層、デモデータ、契約テスト |
| PR-B | Remote MCP、OAuth、Service Binding |
| PR-C | `fukuchan-app`のGemini tool calling、実データ切り替え |

実データ同期用のローカル設定や生成SQLはGit管理しない。

## 4. フェーズ0：実装前の決定

### 作業

- [ ] 同期元ホストを決める（常時起動Mac等／手動CSVから開始）
- [ ] P0の同期範囲を「日次・月次・カテゴリ・資産の集計のみ」で確定する
- [x] 外部MCPの認証方式をGitHub OAuthに決める
- [x] 家計集計値をGeminiへ送る（集計結果・鮮度・基準日時のみ）と決める
- [ ] Money Forward MEのWeb自動操作を継続利用するリスクを受容するか決める
- [ ] 使用する`mf-dashboard`のリリースまたはコミットを固定する
- [ ] Cloudflare D1・OAuth関連の利用条件とアカウント設定を確認する

### Go条件

- ブロッキング5項目にユーザーの判断がある。
- 認証情報の保管場所と、AIへ送るデータ範囲が明文化されている。

### No-Go時の代替

- 常時起動ホストを使わない場合：手動CSVをD1へインポートするPoCだけ行う。
- Geminiへ家計データを送らない場合：外部MCPだけを提供し、ふくちゃん統合をスコープ外にする。
- Web自動操作を採用しない場合：現行CSVの手動更新を継続し、MCP照会だけを実装する。

## 5. フェーズ1：デモデータによるD1・query層PoC

### 作業

- [x] `workers/finance-mcp/`のプロジェクト雛形を作成する
- [x] D1のローカル開発用スキーマを作成する
- [x] 実在しないデモ家計データを作成する
- [x] `sync_runs`、`daily_summaries`、`monthly_summaries`、`category_daily_totals`、`category_totals`、`asset_summaries`を作成する
- [x] activeスナップショットだけを読むquery層を実装する
- [x] P0の5照会関数を実装する
- [x] 金額、日付境界、月、件数、0除算、対象月なし、staleをテストする
- [x] `period_mode=auto`で現在月の日次同期間比較ができることをテストする
- [x] 比較先の月末丸めと、日次データなしの`unsupported_granularity`をテストする

### 検証

```text
npm test
wrangler d1 execute <DB> --local --file <schema>
wrangler dev -c <finance-worker-config>
```

実装時には、リポジトリで固定した正式なスクリプト名を使用する。

### Go条件

- デモデータの代表質問10件で期待値と一致する。
- query層にINSERT、UPDATE、DELETE、任意SQL実行機能がない。
- ログにデータ値が出ない。

### 実績（2026-09-11）

- `npm test`で既存23件とfinance query 12件の合計35件が成功した。
- `wrangler d1 execute --local`で`schema.sql`と`demo-data.sql`を投入し、日次・月次・カテゴリ・資産テーブルを検証した。
- `npx wrangler deploy --config workers/finance-mcp/wrangler.toml --dry-run`でWorkerバンドルとD1バインディングを確認した。

## 6. フェーズ2：Remote MCPと認証

状態: ローカル実装完了。公式MCP SDK v2とCloudflare OAuth Providerを採用し、stateless構成で契約を固めた。

### 作業

- [x] statelessなStreamable HTTP MCPハンドラを`/mcp`へ実装する
- [x] 5つのMCPツールへquery層を接続する
- [x] 入力スキーマを定義し、月形式・件数上限を検証する
- [x] OAuth Providerを実装する
- [x] OAuth client、暗号鍵、必要なKV等の設定項目をWranglerへ宣言する（本番実値はSecrets/Varsへ設定済み）
- [x] 未認証、期限切れ、許可外ユーザーを拒否する
- [ ] MCP Inspectorと対象クライアントで接続確認する
- [ ] ツール評価テストをCIへ追加する

### フェーズ2で先に実装する範囲

- `McpServer`をリクエスト単位で生成し、D1 query関数を5ツールへ接続する。
- `OAuthProvider`のGitHub認可画面・callback・token endpointの契約を用意する。GitHub APIでloginを確認し、許可リスト外は承認しない。
- OAuth Providerの`ctx.props`をMCP SDKの`authInfo`へ渡し、ツール側は認証済みであることを前提にする。
- 本番のGitHub Client ID/Secret、Cookie暗号鍵、OAuth KV、許可login、公開URLは、コードへ値を入れずWrangler Secrets/Varsで設定する。
- 本番OAuth同意画面とMCP Inspector接続は、ローカル契約テスト後にユーザー承認を得て実施する。

### 実績（2026-09-11）

- `@modelcontextprotocol/server` 2.0.0、`@cloudflare/workers-oauth-provider` 0.10.3、`zod` 4.2.0を固定した。
- `POST /mcp`はstatelessで、SDKの2025-era互換と2026-07-28 modern envelopeを利用できる構成にした。
- GitHub OAuth callbackでは`read:user`だけを要求し、許可login以外、state不一致、GitHub上流障害をfail-closedにした。
- 実トークンを保存・ログ出力せず、OAuth Providerの`ctx.props`からMCPへは認証済みマーカーと最小の主体情報だけを渡す。
- 未認証アクセスのローカルsmoke testはHTTP 401、`/health`はHTTP 200を確認した。
- 本番D1/KV ID、GitHub OAuth secrets、許可login、callback URLを設定し、finance Workerを本番デプロイ済みである。実クライアント接続は未確認。

### セキュリティゲート

- 認証なしの`/mcp`からツール一覧・結果を取得できない。
- OAuth secretやトークンがGit・CIログ・Workers Logsにない。
- write tool、任意SQL、raw transaction toolが存在しない。
- ツール結果に口座番号、カード番号、取引摘要がない。

### Go条件

- 認証済みの管理者だけが5ツールを実行できる。
- MCP Inspectorと少なくとも1つの実クライアントで成功する。

## 7. フェーズ3：Service Bindingとふくちゃん統合

### 作業

- [x] finance Workerへ内部RPC entrypointを追加する
- [x] `fukuchan-app`のWrangler設定へ`FINANCE_SERVICE` bindingを追加する
- [x] Gemini REST APIへfinance toolのfunction declarationを追加する
- [x] function callのツール名と引数をallowlist検証する
- [x] tool resultをfunction responseとしてGeminiへ返す
- [x] 家計回答へ基準日時を付けるようsystem instructionで指定する
- [x] 家計質問時に旧`finance.csv`を同時投入しない機能フラグを追加する
- [x] 一般ナレッジ・雑談・認証の回帰テストを行う

### 代表質問

- 今月の収支は？
- 先月の食費はいくら？
- 今月の食費は先月に比べてどう？（今月1日〜今日と先月1日〜同日）
- 今月と先月で支出はいくら変わった？
- 最新の総資産は？
- データはいつ時点？
- 存在しない月の収支は？
- 明日の天気は？（家計ツールを呼ばない）

### Go条件

- 代表質問で適切なツールだけを呼ぶ。
- ツール結果にない金額を補完しない。
- 既存23件の契約テストと新規テストがすべて成功する。
- finance Worker停止時、一般ナレッジと雑談は利用でき、家計回答だけ安全に失敗する。

### 実績（ローカル統合）

- `workers/finance-mcp/src/contracts.js`を共有契約として追加し、MCP・Service Binding RPC・Geminiの5ツール定義を一元化した。
- finance Workerの`WorkerEntrypoint`へP0の5 RPCメソッドを追加し、RPC境界でもzod入力検証を行うようにした。
- `fukuchan-app`へ`FINANCE_SERVICE` bindingと`FINANCE_TOOL_ENABLED`フラグを追加した。フラグがfalseなら旧CSV経路、trueなのにbindingが無ければ503で停止する。
- Geminiのfunction callを最大2ラウンド処理し、未知ツール・不正引数・RPCエラーは固定エラーだけをfunction responseへ返すようにした。
- `npm test`：57件すべて成功。root Workerとfinance Workerのdry-runも成功し、finance Workerを本番デプロイ済み。
- 実データ、root Workerの`FINANCE_TOOL_ENABLED=true`切り替え、実クライアント接続は未実施。

## 8. フェーズ4：同期exporter

### 4A. 先に手動CSVで検証

- [ ] 現行`finance.csv`を読み、D1用SQLへ変換するimporterを作成する
- [ ] ローカルD1へ投入し、元CSVとの合計一致を確認する
- [ ] 月次CSVでは`full_month`だけを提供し、同期間比較は日次データ不足として安全に拒否する
- [ ] ユーザー承認後、remote D1へデモまたは手動データを投入する
- [ ] ふくちゃんと外部MCPの結果が一致することを確認する

### 4B. `mf-dashboard` SQLite対応

- [ ] 固定したupstreamをローカルへセットアップする
- [ ] 1Password Service Accountの権限を対象保管庫・対象項目だけに限定する
- [ ] crawlerを手動実行し、SQLiteが更新されることを値非表示で確認する
- [ ] SQLiteスキーマを調査し、exporterの入力契約をfixtureとして固定する
- [ ] 日次・月次・カテゴリ・資産集計を生成する
- [ ] 日次集計の合計と月次集計が一致することを検証する
- [ ] 振替、重複、取消、未分類、負債の扱いを検証する
- [ ] 一時SQLを生成し、remote D1へ投入する
- [ ] activeスナップショット切り替えと旧世代保持を確認する
- [ ] 同期スケジュールを設定する

### Go条件

- 元SQLiteとD1の月次合計・カテゴリ合計が全対象月で一致する。
- 途中失敗時に旧activeが維持される。
- 認証情報、取引摘要、口座番号がD1へ含まれない。
- 最終同期時刻と件数だけで運用状態を確認できる。

## 9. フェーズ5：本番ロールアウト

### 作業

- [x] finance WorkerとD1を本番へデプロイする（D1スキーマ・架空デモデータ適用済み、Workerは2026-09-12デプロイ）
- [ ] OAuth認証を本番URLで確認する
- [ ] `fukuchan-app`へService Bindingを設定する
- [ ] 管理者だけ新finance toolを有効にする
- [ ] 旧CSV回答と新ツール回答を7日間比較する
- [ ] 「今月の食費は先月に比べてどう？」を同期間（当日まで）で7日間比較する
- [ ] 金額差異、ツール誤選択、同期失敗、stale警告を記録する
- [ ] Go判定後、全利用者へ切り替える
- [ ] 14日間、旧`finance.csv`をロールバック用に保持する
- [ ] 安定後、旧CSVをチャットのナレッジ読込対象から外す

### 本番Go条件

- 7日間で重大な金額差異が0件。
- 代表質問の正答率100%。
- 未認証アクセス成功0件。
- 同期失敗時に直前データへ安全にフォールバックできる。
- ロールバック手順を実際に1回確認している。

## 10. フェーズ6：運用

- [ ] upstreamの更新を月1回確認する
- [ ] Money Forward MEのログイン画面変更時だけcrawlerを追随する
- [ ] Cloudflare依存パッケージの更新を月1回確認する
- [ ] D1のactive + 直前2世代以外を削除する
- [ ] 24時間同期なし・連続2回失敗を確認する手順を運用文書へ追加する
- [ ] OAuth利用者とクライアント登録を定期レビューする
- [ ] 90日ごとに同期用Cloudflare tokenの継続要否を確認する

## 11. CI/CD

### Pull Request

- formatter / lint
- unit test
- D1 migrationのローカル適用
- MCP契約テスト
- ツール評価テスト
- secret pattern scan
- Wrangler dry-run

### mainへのマージ

推奨デプロイ順:

1. D1 migration
2. finance MCP Worker
3. `fukuchan-app`
4. 本番smoke test

finance Workerのデプロイが失敗した場合、`fukuchan-app`のデプロイを実行しない。実データ同期はアプリデプロイと分離し、コード変更だけで金融データを書き換えない。

## 12. ロールバック

### アプリ

- finance tool機能フラグを無効にし、旧`finance.csv`へ戻す。
- 既存Workerの直前Versionへ`wrangler rollback`する。

### finance Worker

- 直前Versionへロールバックする。
- OAuth設定とD1は保持し、障害調査後に再有効化する。

### データ

- `sync_runs`で直前の成功`sync_id`をactiveへ戻す。
- upstream SQLiteと生成SQLはローカルのバックアップから再生成する。
- D1全削除や上書きインポートをロールバック手段にしない。

## 13. 工数感

前提が揃っている場合の相対規模。

| フェーズ | 規模 | 主な不確実性 |
|---|---|---|
| 0. 前提決定 | 小 | ユーザー判断 |
| 1. D1/query PoC | 中 | 集計仕様 |
| 2. Remote MCP/OAuth | 中 | OAuthクライアント互換性 |
| 3. ふくちゃん統合 | 中〜大 | Gemini tool callingと既存処理の共存 |
| 4. 実データ同期 | 大 | Money Forward画面、upstream SQLiteスキーマ |
| 5. ロールアウト | 中 | 実データ差異 |

最大の不確実性はMCPそのものではなく、Money Forward MEの非公式Web取得を継続運用できるかである。

## 14. 完了の定義

- 要件定義のP0をすべて満たす。
- 外部MCPとふくちゃんトークが同じactiveデータから同じ値を返す。
- 認証情報、明細、口座情報がPublicリポジトリとログに含まれない。
- 同期失敗、データ欠落、stale、OAuth失敗のテストがある。
- 代表質問10件のツール選択と金額が100%正しい。
- 今月途中の同期間比較が、日付範囲・金額・差額・増減率ともに100%正しい。
- ロールバックを実施し、旧CSVへ戻せる。
- セットアップ、同期、障害対応、資格情報ローテーションの運用手順がある。

## 15. 次に行うこと

フェーズ3のローカル統合とCloudflare外部設定は完了した。finance Worker用D1/KVを作成し、リモートD1へ`schema.sql`と架空の`demo-data.sql`を適用済みである。GitHub OAuth App、Secrets、許可login、callback URLを設定し、finance Workerを本番デプロイ済みである。次はOAuthの実ブラウザ／MCP Inspector接続を確認し、root Workerの`FINANCE_TOOL_ENABLED=true`切り替え後に代表質問を検証する。その後、手動CSVまたは固定したupstream SQLiteからのフェーズ4同期exporterへ進む。同期元ホストとMoney Forward MEのWeb自動操作リスクは、実データ同期前に別途確定する。

### 外部設定確認の実績（2026-09-11）

- `npx wrangler whoami`：対象CloudflareアカウントへのOAuthログインを確認した。
- `npx wrangler d1 list`：`fukuchan-finance`を作成済み。
- `npx wrangler kv namespace list`：`OAUTH_KV`を作成済み（保存データなし）。
- 発行されたIDを`workers/finance-mcp/wrangler.toml`へ反映し、finance Worker dry-runでD1/KVバインディングを確認した。
- `npx wrangler d1 execute fukuchan-finance --remote --file workers/finance-mcp/schema.sql`：11クエリ成功、6つのアプリ用テーブルを作成した。
- 架空`demo-data.sql`をリモート投入し、`sync_runs` 1件、`daily_summaries` 22件、`monthly_summaries` 2件、`category_daily_totals` 22件、`category_totals` 4件、`asset_summaries` 3件を確認した。
- Secrets登録とWorkerデプロイは2026-09-12に実施済み。実データ投入は未実施。
