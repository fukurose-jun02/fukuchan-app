# 実装計画書：家計簿のMCP化

対応要件: [requirements.md](requirements.md)  
対応設計: [design.md](design.md)  
作成日: 2026-09-11  
状態: Phase 3 complete / Phase 5 rollout in progress（Cloudflare認証・D1/KV作成・スキーマ適用・架空デモデータ投入・OAuth secrets設定・finance Workerデプロイ・MCP Inspector 5ツール確認・root Worker finance有効化・本番デモ自然文確認・Browser Run接続確認・実ログインPoCでOTP要求まで確認済み、OTP後の取得・実データ同期・本番Cron待ち）

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
- [x] MCP InspectorでOAuth接続と5ツールの実応答を確認する（実クライアントは別途）
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
- 実データ同期と実クライアント接続は未実施。root Workerの`FINANCE_TOOL_ENABLED=true`切り替えと本番デプロイは完了した。

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

フェーズ3のローカル統合とCloudflare外部設定は完了した。finance Worker用D1/KVを作成し、リモートD1へ`schema.sql`と架空の`demo-data.sql`を適用済みである。GitHub OAuth App、Secrets、許可login、callback URLを設定し、finance Workerを本番デプロイ済みである。MCP InspectorでOAuth接続と5ツールの実応答を確認し、root Workerも`FINANCE_TOOL_ENABLED=true`で本番デプロイした。最終合成ターンではfunctionResponseを唯一の根拠とする指示を追加し、架空デモ値で自然文回答を再現確認した。さらに本番Workerで日付履歴付きの代表質問を実行し、食費55,000円・先月33,000円・差額+22,000円、鮮度stale、基準日時の反映を確認した。手動CSVなしの自動同期については、[ADR-002](adr-002-automatic-sync.md)を提案状態で追加した。非機密のBrowser Run/Cron fixture PoC、Browser Run接続、Money Forwardの実ログインPoC（OTP要求まで）を確認済みである。次はOTPを安全に扱う方式と、認証後の集計取得を検証する。実データ同期・D1投入・本番Cron有効化は別途Go/No-Goと承認が必要である。

### 外部設定確認の実績（2026-09-11）

- `npx wrangler whoami`：対象CloudflareアカウントへのOAuthログインを確認した。
- `npx wrangler d1 list`：`fukuchan-finance`を作成済み。
- `npx wrangler kv namespace list`：`OAUTH_KV`を作成済み（保存データなし）。
- 発行されたIDを`workers/finance-mcp/wrangler.toml`へ反映し、finance Worker dry-runでD1/KVバインディングを確認した。
- `npx wrangler d1 execute fukuchan-finance --remote --file workers/finance-mcp/schema.sql`：11クエリ成功、6つのアプリ用テーブルを作成した。
- 架空`demo-data.sql`をリモート投入し、`sync_runs` 1件、`daily_summaries` 22件、`monthly_summaries` 2件、`category_daily_totals` 22件、`category_totals` 4件、`asset_summaries` 3件を確認した。
- Secrets登録とWorkerデプロイは2026-09-12に実施済み。実データ投入は未実施。

### OAuth設定・本番smoke test（2026-09-12）

- GitHub OAuth Appのcallback URLを`https://fukuchan-finance-mcp.fukuchan-app.workers.dev/github/callback`へ設定し、許可loginをWrangler varsへ反映した。
- `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`COOKIE_ENCRYPTION_KEY`をローカルの`--secrets-file`からfinance Workerへ投入した。秘密値はリポジトリ・会話・ログへ記録していない。
- `npx wrangler deploy --config workers/finance-mcp/wrangler.toml --dry-run --secrets-file workers/finance-mcp/.dev.vars`成功後、本番デプロイを実行した。
- 本番URLの`/health`はHTTP 200、未認証`POST /mcp`はHTTP 401、OAuthパラメータなし`/authorize`はHTTP 400を確認した。
- Dynamic Client Registrationの疎通確認後、一時テストクライアントとKVキーを削除した。実ユーザーによるOAuth認証とMCPツール実応答をMCP Inspectorで確認済みである。
- MCP Inspectorの初回OAuthでscope省略時に`invalid_scope`、再認証時に`Invalid authorization code format`となる不具合を確認した。scope省略時は`mcp:read`を既定付与し、明示された未対応scopeを拒否する修正に加え、Providerの区切り文字と衝突しないuserId形式へ変更した。OAuthテスト9件成功後にfinance Workerを再デプロイし、MCP Inspectorで実ユーザーの再認証と5ツールの実応答を確認した。
- MCP InspectorでOAuth接続後、5ツールすべての実応答を確認した。食費の同期間比較は33,000円から55,000円、差額22,000円、増減率66.7%となり、資産集計は純資産1,300,000円となった。
- デモfixtureでは月次9月支出が日次合計より10,000円少なかったため、148,000円（収支152,000円）へ修正した。リモートD1で月次・日次・取引件数が一致することを再検証した。

### 自動同期PoC（2026-09-12）

- [ADR-002](adr-002-automatic-sync.md)を`Proposed`として追加し、既存のローカル認証情報保管要件は変更していない。
- Wrangler 4.129.0の`browser` CLIで、空のBrowser Runセッションを60秒だけ作成・表示確認・終了した。残存セッションは0件である。
- `workers/finance-sync/poc/`に、Money Forward・Browser Run・D1へ接続しないCron fixture Workerを追加した。
- fixtureテスト2件、`wrangler deploy --dry-run`、`wrangler dev --test-scheduled`での`/health`と`/__scheduled`呼び出しに成功した。
- Browser Runで認証情報なしに`https://id.moneyforward.com/sign_in`へ到達し、origin・パス・読み込み完了状態を確認した。画面内容・Cookie・認証情報は保存していない。
- 未認証画面のフォーム構造を確認し、メール入力欄・パスワード入力欄が存在すること、CAPTCHA/OTP表示がないことを確認した。ログイン後の挙動は未確認である。
- Cloudflare公式仕様を確認した。Freeは1日10分・同時3ブラウザ、Paidは10時間/月を含み超過分はブラウザ時間$0.09/時間、アイドルタイムアウトは60秒（`keep_alive`で最大10分）、リクエストはBotトラフィックとして識別される。
- Money Forward ME公式利用規約を確認した。ID・パスワードの貸与・譲渡・第三者利用を禁止し、アグリゲーション先コンテンツサイトへの自動入力/API接続は利用者自身の行為として責任を負う旨がある。Cloudflareへの認証情報保管は、ユーザーの規約・セキュリティ判断を経るまで実施しない。
- 実データへのログイン、認証情報入力、Browser Runからの画面取得、D1投入、Cron本番デプロイはまだ実施していない。

### 実ログインPoCの承認（2026-09-12）

- ユーザーはCloudflare SecretsへのMoney Forward認証情報保管と、実ログインPoCを1回実行することを承認した。
- PoCの目的はログイン成功、Bot対策、OTP要求、セッション失効の状態分類だけとする。画面本文、Cookie、取引明細、スクリーンショット、一時セッションは保存しない。
- 認証情報は会話・Git・ログへ出力せず、Geminiへの実データ送信、D1への実データ投入、本番Cron有効化、セッション永続化は行わない。
- PoC結果をもとにGo/No-Goを判断し、実データ同期へ進む場合は別途ユーザー承認を得る。

### 実ログインPoC専用Workerの実装（2026-09-12）

- `workers/finance-sync/login-poc/`に、定期Cron・D1 bindingを持たない専用Workerを追加した。
- Browser Run bindingは`BROWSER`、実行口は`POST /poc/login`とし、`SYNC_POC_TOKEN`のBearer認証と`POC_ENABLED=true`の二重ゲートを設けた。
- `MF_LOGIN_EMAIL`と`MF_LOGIN_PASSWORD`はWorker Secretsからだけ参照し、レスポンス・ログへ値を出さない。
- 結果は`AUTHENTICATED`、`AUTH_FAILED`、`OTP_REQUIRED`、`BOT_BLOCKED`、`BROWSER_ERROR`、`UNEXPECTED_STATE`の粗い分類とorigin/pathだけを返す。Cookie、画面本文、取引明細、スクリーンショット、Storage Stateは保存しない。
- `finally`でBrowser Runを閉じる。PoC専用Workerには本番Cronを設定せず、PoC終了後は`POC_ENABLED=false`へ戻して手動起動口を無効化する。
- Wrangler dry-run後、ユーザーがローカルの無視対象Secretsファイルへ値を入力し、`--secrets-file`でPoC専用Workerを一時有効化してデプロイした。`/health` 200と未認証401を確認した後、認証済みの実ログイン試行はHTTP 400（本文なし）で判定未到達だった。ユーザーの再試行承認後に安全なtailを併用して1回だけ再試行したが同じHTTP 400であり、追加試行を行わず`POC_ENABLED=false`で再デプロイした。

### 公開ページによるBrowser Run切り分け（2026-09-12）

- Money Forwardへ接続しない`https://example.com`を同じWorkerから開く診断口を一時追加した。
- 公開ページでもHTTP 400（本文なし）となり、ログイン状態の分類以前にWorker→Browser Run接続が成立していない可能性が高いと判断した（推測）。
- 診断口は確認後にコードから削除し、PoC専用Workerを`POC_ENABLED=false`で再デプロイした。
- Browser Run接続が解消するまで、認証付きログインの追加試行、実データ同期、本番Cron、D1投入は停止する。

### Wrangler更新後の再診断（2026-09-12）

- プロジェクトのWranglerを`4.129.0`からユーザー環境と同じ`4.131.1`へ更新し、全68テストとdry-runに成功した。
- 同じ公開ページ診断を1回実行したが、HTTP 400（本文なし）が再現した。診断後はエンドポイントを削除し、`POC_ENABLED=false`で再デプロイした。
- CLIバージョン差では解消しないため、次はCloudflareのBrowser Run利用状態・アカウント側設定・実行障害の確認とする。

### CDP互換性フラグの切り分け（2026-09-12）

- Cloudflare公式READMEに記載された`no_websocket_standard_binary_type`をPoC専用Workerへ一時適用した。
- `https://example.com`の公開ページ診断を1回実行したが、HTTP 400（本文なし）が再現した。標準CDPと旧互換経路の切り替えでは解消しなかった。
- 診断用エンドポイントを削除し、標準設定・`POC_ENABLED=false`でWorkerを再デプロイした。
- 次はCloudflareダッシュボードのBrowser Run利用状態・アカウント設定・サポートログを確認し、解消しない場合はBrowser Run案を採用しない。

### PoC結果の訂正と更新（2026-09-12）

- 先行記録のHTTP `400`はBrowser Run bindingの障害ではなく、`SYNC_POC_TOKEN`へ端末ANSI制御文字が混入し、AuthorizationヘッダーがCloudflare端で拒否されたことが原因だった。
- トークンをASCIIの64文字hexへローテーションした後、同じWorkerから`https://example.com`を開く診断はHTTP `200`となり、Browser Runのアカウント・Worker bindingが利用可能であることを確認した。
- Money Forwardの送信ボタンセレクタを`button#submitto`優先へ修正し、実ログインPoCはHTTP `200`で`OTP_REQUIRED`、`/email_otp`へ到達した。認証後の画面取得・OTP入力・セッション永続化を示すものではない。
- 診断ルートを削除し、PoC専用Workerは`POC_ENABLED=false`へ戻した。実データの取得・D1投入・本番Cron有効化は未実施である。
- 次のGo/No-Go判定は、OTPを安全に扱う方式と、認証後の必要集計を安定取得できるかの確認である。
