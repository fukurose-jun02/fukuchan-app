# Cloudflare移行計画レビュー

- [x] `docs/` の計画書と現行実装を照合する
- [x] Cloudflare・Gemini・GitHubの公式仕様で重要事項を検証する
- [x] セキュリティ、切り替え、ロールバック、運用・監視の抜けを確認する
- [x] 重要度順に指摘と改善案をまとめる

## Review

判定: 実装開始前に要修正。

主な修正事項:

1. クライアント側PINとは別に、`/chat`へサーバー側認証を設ける。
2. Pages + Worker分離案と、現行推奨のWorkers Static Assetsによる一体構成を比較し、ADRとして決定する。
3. ローカル秘密情報はgitignore済みの`.dev.vars`で扱い、`wrangler secret put`が即時デプロイを伴うことを手順へ反映する。
4. 日付注入、履歴role、Geminiモデル、REST payload/responseを正規のAPI契約として確定し、自動契約テストを追加する。
5. GitHub PagesとCloudflare側で独立した切り戻し経路を作り、LINEのリンク変更・旧URL転送も切り替え手順へ追加する。
6. 入力上限、レート制限、GitHub取得失敗時のfail-closed、タイムアウト、ログ・メトリクス・アラートを定義する。
7. 公開README、SETUP_MANUAL、CI/CD、ツールチェーン固定、旧環境の保持期間を完了条件へ加える。

## Re-review（2026-09-05）

判定: 大幅改善。ただし実装開始前に高優先の修正が残る。

解消済み:

- Workers Static Assetsによる単体構成と同一オリジン化
- 日付処理・履歴role・Geminiモデルの契約整理
- `.dev.vars`と本番Secretsの分離、`secret put`の即時デプロイ認識
- GitHub取得失敗時のfail-closed、タイムアウト、基本テスト
- LINEリンク切り替え、2週間の旧環境保持、CI/CD、文書更新範囲

実装前の必須修正:

1. PIN入力時に認証を完了できる`/auth`またはCloudflare Accessへ変更し、公開JSの`CORRECT_PIN`を削除する。
2. `workers.dev`ではzone向けWAF Rate Limiting Rulesを使わず、Workers Rate Limiting bindingまたはAccessを採用する。4桁PINに20回/分は緩すぎる。
3. ルートの旧`index.html`を切り替えまで保持し、Worker用には`public/`へコピーする。旧版をタグ・専用ブランチ等で固定し、LINEリンクを含む復旧手順を用意する。
4. `public/images/fuku-icon.png`を含む全静的アセットを移し、配信テストを追加する。
5. Worker側でraw body、history件数、各content、総文字数を制限する。

追加修正:

- GeminiキーをURL queryではなく`x-goog-api-key`ヘッダーで送る。
- `@cloudflare/vitest-pool-workers`を現行の`@cloudflare/vitest-plugin`へ更新する。
- 必須secret未設定時は503でfail-closedし、可能なら一括投入する。
- ログへPIN、Authorization、会話、ナレッジ、上流秘密情報を出さない。
- `GITHUB_REPO`のWrangler vars、Workers Logs設定、上流エラー契約とテストを明記する。
- 要件書に残るCloudflare Pages表記をWorkers Static Assetsへ統一する。

## Final re-review（2026-09-05）

判定: 前回指摘の大半は解消。以下を直した後に実装着手可。

実装前の必須修正:

1. Publicリポジトリへ実PIN・実在人物の情報を記載しない。例をプレースホルダーへ置換し、公開済みPINは移行時に必ず新しい値へローテーションする。
2. Workers Rate Limiting bindingは10秒または60秒窓しか扱えず、「5回/15分」は実装不能。4桁PINを維持するならAccessまたは状態を持つ厳密なロックアウトへ変更する。簡易bindingを使うならPINを十分に長いパスフレーズへ変更し、補助防御として位置づける。
3. 50KB上限を`Content-Length`だけに依存させず、実際に読み込んだUTF-8バイト数を検証する。ヘッダー欠落・偽装ケースをテストへ加える。
4. Secrets初回投入を4回の`wrangler secret put`にしない。`--secrets-file`を使った単一Versionのupload/deploy等へ統一し、必須secret名をWrangler設定で宣言する。
5. Workers Logs設定を現行仕様の`[observability] enabled = true`へ直し、新規Workerは既定有効である旨と、Free 3日/Paid 7日の保持期間を反映する。

実装と同時に詰める事項:

- Static Assetsの`directory`・`binding`・API向け`run_worker_first`を`wrangler.toml`に明記する。
- テスト用パッケージを現行の`@cloudflare/vitest-plugin`へ確定し、429の契約テストを追加する。
- 30日Bearerの`localStorage`保存をHttpOnly Cookieへ変更するか、TTL短縮・署名鍵ローテーションによる失効手順と残余リスクを明記する。
- GitHub/Geminiのタイムアウト応答を502/504のどちらかへ統一する。
- カットオーバー直後か2週間後か、GitHub Pages転送ページへの切替時期を3章・8章・実装計画で統一する。
- Gemini APIキーが現行のAuth keyであることをデプロイ前に確認する。
- 親リポジトリの`.gitignore`へ`/fukuchan-knowledge/`を追加し、Privateな入れ子リポジトリの誤追加を防ぐ。

### 認証方針の決定

- 4桁数字のPINを維持し、Durable Objectは導入しない。
- `/auth`にはWorkers Rate Limiting bindingで実装可能な60秒窓の制限を設ける。
- 厳密な総当たり防止にはならないことを残余リスクとして受容する。
- 公開済みのPIN値は再利用せず、移行時に別の4桁へローテーションする。

## Phase 0 Go/No-Go確認（2026-09-05）

判定: Phase 0（現行mainへのタグ付与・作業ブランチ作成）はGo。

開始前確認:

- 現在のブランチは`main`。
- ローカルの`main`と追跡中の`origin/main`は同じコミット`1a65d44`を指している。
- `pre-cloudflare-migration`タグと`cloudflare-migration`ブランチは未作成。

後続フェーズまでに残っていた文書修正（対応済み）:

- [x] `/auth`のRate Limitを`5回/60秒/IP`へ統一
- [x] 初回本番投入を`wrangler deploy --secrets-file .dev.vars`の単一操作へ統一
- [x] 転送ページへの切り替え時期を「カットオーバー直後」へ統一
- [x] 概要表に残っていた`wrangler secret put`表記（`design.md` 43行、`implementation-plan.md` 12行）を確定手順へ統一

## Phase 3 secret準備（2026-09-05）

- [x] ローカル既存資料から`GEMINI_API_KEY`と`GITHUB_TOKEN`を値非表示で`.dev.vars`へ転記
- [x] 公開済みPINと異なる新しい4桁`WORKER_PIN`を生成
- [x] 会話に露出した値を再利用せず、256-bit相当の`AUTH_TOKEN_SECRET`を新規生成
- [x] `.dev.vars`の4キー、形式、ファイル権限600、gitignoreを確認
- [x] 既存secretを含むローカル専用手順書をgitignoreへ追加
- [x] 自動テスト23件の成功を確認

## Phase 3 ローカル動作確認（2026-09-05）

状態: 完了。外部APIを含む正常系`/chat`まで確認済み。

- [x] `/health` 200
- [x] `/auth` 正しいPINで200・Cookie発行、誤ったPINで401
- [x] `/chat` Cookieなしで401
- [x] 長文で413、不正roleで413
- [x] `/`と`/images/fuku-icon.png`が200
- [x] 無効なGitHub資格情報を502でfail-closed
- [x] 新しいGitHub fine-grained PAT（対象repo限定、Contents read-only）へ更新
- [x] 新しいGemini Auth keyへ更新
- [x] ユーザーの明示承認後、PrivateナレッジをGeminiへ送信する実フローで`/chat`正常系200と応答本文の存在を確認

## 全体進捗のログ再照合（2026-09-06）

- [x] フェーズ0〜5：完了（本番手動デプロイ、カットオーバー、LINEリンク更新を含む）
- [x] フェーズ4のCI/CD自動化：ワークフロー作成・GitHub Actions Secrets登録・main pushでの実行確認まで完了
- [ ] フェーズ6：2週間の監視期間中。定期確認は設定済み、最終確認は2026-09-19予定
- [ ] フェーズ7：監視終了後に旧Cloud Run、旧Python backend、Pages workflowを削除予定

## Issue管理ルールの明文化（2026-09-10）

- [x] `AGENTS.md`に、このフォルダのIssueを`fukurose-jun02/fukuchan-app`で管理するルールを追加
- [x] `CLAUDE.md`を`AGENTS.md`へのシンボリックリンクにし、Claude Codeからも同じルールを参照可能にした
- [x] Issue操作前にリポジトリ完全名を確認する再発防止策を`tasks/lessons.md`へ記録

### Review

- アプリ開発・デプロイ・インフラ・運用監視のIssue作成先を`fukuchan-app`へ統一した。
- 同番号Issueの取り違えを防ぐため、作成だけでなく参照・更新・クローズ時の確認規則も明記した。
- 指示の実体は`AGENTS.md`に一本化し、`CLAUDE.md`から同じファイルを参照する構成にした。

## Issue #2：Cloudflare Workers CI/CD自動化（2026-09-10）

- [x] 現行のデプロイ方式・Issue要件・Cloudflare公式仕様を照合する
- [x] PRでは契約テスト、mainへのpushでは契約テスト成功後に本番デプロイするワークフローを作成する
- [x] Wranglerに本番必須シークレット名を宣言し、値をGitHubへ複製せず設定漏れを検知する
- [x] Node.jsバージョンを固定し、ローカルとCIのツールチェーンを一致させる
- [x] README・設計・実装計画を実際のCI/CD方式へ更新する
- [x] ローカルテスト、ワークフロー構文、差分、秘密情報非混入を検証する
- [x] GitHub Actions用のCloudflare認証情報を設定し、実際のワークフロー成功を確認する

### 方針

- CIでは`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`だけをGitHub Actions Secretsとして使用する。
- アプリ本体の4シークレットはCloudflare Workers Secretsを正本とし、CIから値を再投入しない。
- `wrangler deploy`は既存Secretsを保持する。`[secrets].required`で4つの存在をデプロイ前に検証する。

### Review

- `npm test`：23件すべて成功。
- `npx wrangler deploy --dry-run`：設定読込・Workerバンドル・静的アセット3件の読込に成功。
- Workflow YAMLの構文解析と`git diff --check`に成功。
- PRのテストと本番デプロイを条件分岐し、PRから本番へデプロイされないことを確認した。
- [PR #4](https://github.com/fukurose-jun02/fukuchan-app/pull/4)のチェック成功後にmainへマージした。
- main pushのActions Run 2（23テスト成功、Wranglerデプロイ成功）を確認した。
- 本番Workerの`/health`がHTTP 200・`{"status":"ok"}`を返すことを確認した。
- `CLOUDFLARE_API_TOKEN`（対象アカウントのWorkers Scripts: Edit）と`CLOUDFLARE_ACCOUNT_ID`をGitHub Actions Secretsへ登録した。
- ActionsのNode.js 20非推奨警告（`actions/checkout@v4`・`actions/setup-node@v4`）は出たが、ジョブは成功。アクションのメジャー更新時に追随する。

## 旧fukuchan-knowledge Issue #1：家計簿MCP化の事前設計（2026-09-11）

- [x] 対象Issueのリポジトリ完全名と本文を確認する
- [x] 現行のふくちゃんトークと家計データ形式を確認する
- [x] 参照実装`hiroppy/mf-dashboard`の現行版と旧MCP版を比較する
- [x] Cloudflare上でのRemote MCP・認証・Worker間連携の実現性を確認する
- [x] 要件定義書を作成する
- [x] 設計書を作成する
- [x] 実装計画書を作成する
- [x] 3文書の整合性・リンク・秘密情報非混入を検証する

### 現時点の判断

- 条件付きで実現可能。
- 旧v1のstdio MCPとSQLiteを既存Workerへ直接移植する方式は採用しない。
- Money Forward MEの取得は信頼済みローカル環境、照会はCloudflare上の読み取り専用Remote MCPに分離する案を推奨する。

### Review

- `docs/issue-1-household-finance-mcp/`に要件定義書・設計書・実装計画書を作成した。
- 旧v1 MCP、現行v2構成、Cloudflare Remote MCP・D1・Service Binding、Gemini function callingの公式・一次資料を照合した。
- P0は集計データと読み取り専用5ツールに限定し、取引摘要・口座番号・書き込み操作・任意SQLを対象外にした。
- `git diff --check`、文書間リンク、見出し構成、既知のsecret形式非混入を確認した。
- 実装前に決めるブロッキング項目を5件に整理した。実装コードと外部設定はまだ変更していない。

### 要件補足：今月途中と先月同日までの比較（2026-09-11）

- [x] 自然言語の「今月と先月」の既定比較期間を同日までと決める
- [x] `period_mode=auto`、`month_to_date_same_day`、`full_month`の使い分けを文書化する
- [x] 日次集計をD1へ保存する設計へ更新する
- [x] 日次データがない場合に月次全期間で代用しない受け入れ条件を追加する

### Review（要件補足）

- 「今月の食費は先月に比べてどう？」は、当月1日〜Asia/Tokyoの当日と、先月1日〜同日（存在しない場合は先月末）を比較する。
- 現行の月次`finance.csv`だけではこの回答を保証できないため、日次集計を作れる同期経路をP0の前提にした。
- 要件定義書・設計書・実装計画書へ同じ期間ルール、D1テーブル、テスト条件を反映した。

## Issue #1 実装：フェーズ1 D1・query層PoC（2026-09-11）

- [x] `workers/finance-mcp/`のWorker雛形を作成する
- [x] 日次・月次・カテゴリ・資産のD1スキーマを作成する
- [x] 実在しないデモ家計データを作成する
- [x] activeスナップショットを読むquery層を実装する
- [x] P0の5照会関数を実装する
- [x] 同期間比較、月末丸め、stale、対象月なし、0除算、日次データ不足をテストする
- [x] `npm test`と文書・秘密情報チェックを実行する

### 作業方針

- Money Forward ME、Cloudflare本番D1、OAuth、Geminiへの接続はフェーズ1では行わない。
- query層はD1の読み取り専用SQLだけを発行し、INSERT・UPDATE・DELETE・任意SQLを持たせない。
- デモデータとテスト値は実在の家計情報を使わない。

### Review（フェーズ1）

- Worker雛形、D1スキーマ、架空データ、query層、テストを追加した。
- `npm test`：35件すべて成功（既存23件、finance query 12件）。
- `wrangler d1 execute --local`：スキーマ・架空データ投入と日次カテゴリSELECTに成功。
- `wrangler deploy --dry-run`：WorkerバンドルとD1バインディングの読込に成功。
- 本番D1、Money Forward ME、OAuth、Gemini、Service Bindingは変更していない。
- フェーズ0の実データ関連ブロッキング項目は未決定のため、フェーズ2以降の着手条件として残す。
- 対象リポジトリは`fukurose-jun02/fukuchan-app`と確認した。`gh` CLIが未導入のため、実装用GitHub Issueの作成は保留した。
- `AGENTS.md`へ開発文章の必読・状況変化時の自動更新ルールを追加し、`tasks/lessons.md`にも記録した。

## Issue #1 実装：フェーズ2 Remote MCP＋GitHub OAuth（2026-09-11）

状態: ローカル実装完了（実クライアント接続・本番設定待ち）

- [x] GitHub OAuthと「Geminiへ集計結果のみ送信」の方針を確定する
- [x] 公式MCP SDK v2・Cloudflare OAuth ProviderのAPIと制約を確認する
- [x] `POST /mcp`のstateless Streamable HTTPハンドラを実装する
- [x] P0の5ツールをquery層へ接続する
- [x] ツール入力スキーマ、JSON出力、エラー契約を実装する
- [x] GitHub OAuth認可画面・callback・token endpointを実装する
- [x] OAuth許可ユーザー制限とfail-closedを実装する
- [x] ローカル契約テスト（未認証、認証済み、tools/list、tools/call、エラー）を追加する
- [x] WranglerのOAuth KV・Secrets設定項目と本番URL設定手順を追記する
- [x] `npm test`、Worker dry-run、差分・秘密情報チェックを実行する
- [ ] MCP Inspectorと実クライアントでOAuth接続を確認する（本番URL・ユーザー承認待ち）
- [ ] finance MCPのツール評価テストをCIへ追加する

### 方針

- OAuth Providerが検証した`ctx.props`をMCP SDKへ渡し、MCP側でトークンを再実装・再保存しない。
- 金融データはツールが要求した集計結果だけを返し、ユーザー識別子・明細・認証情報を結果やログへ出さない。
- 本番のGitHub Client ID/Secret、Cookie暗号鍵、OAuth KV、許可login、D1 IDはコードへ入れない。

### Review（フェーズ2ローカル実装）

- `npm test`：48件すべて成功（既存アプリ23、finance query 12、MCP 6、OAuth 7）。
- `npx wrangler deploy --config workers/finance-mcp/wrangler.toml --dry-run`：OAuth KV、D1、Workerバンドルの読込に成功。
- ローカルWorker smoke test：`GET /health`は200、未認証`POST /mcp`は401（Bearer challenge）を確認。
- OAuth callbackのstateはKVへ10分・single-useで保存し、GitHub access tokenは保存・ログ出力しない。
- 本番設定（D1/KVの実ID、GitHub OAuth secrets、許可login、callback URL）と実クライアント接続は未実施。

## 本日の作業ログ（2026-09-11）

状態: ユーザー指示により本日はここで中断。次回この続きから再開する。

### 今日完了したこと

- Issue #1 フェーズ2のローカル実装を完了した。Remote MCP、5つの読み取り専用ツール、GitHub OAuth、許可ユーザー制限、fail-closed、契約テストを追加した。
- 開発文章（要件定義書・設計書・実装計画書）とREADME、`AGENTS.md`、この進捗ログを実装内容に合わせて更新した。
- `npm test` は48件すべて成功した。
- Worker dry-run、`/health`（200）、未認証`POST /mcp`（401）、未設定OAuth（503）、差分・リンク・秘密情報チェックを確認した。

### 次回に残っていること

- 本番D1/KVの実ID、GitHub OAuth App（Client ID/Secret・callback URL・許可login）、必要なSecretsとOrigin設定を確定する（まだ本番変更・本番デプロイはしていない）。
- MCP Inspectorまたは実クライアントでOAuth接続と5ツールの実応答を確認し、finance MCPの評価テストをCIへ追加する。
- その後、実装計画書に沿ってService BindingとGemini function callingを実装する。Geminiへ渡すのは集計値・期間・鮮度・as-ofに限定する。
- `gh` CLIが未導入のため保留中の実装用Issueを、対象リポジトリ`fukurose-jun02/fukuchan-app`へ作成する。
- `npm install`時に表示された依存関係のhigh severity警告は、実装再開後に影響範囲を確認する（自動修正は行わない）。

### 次回の開始手順

1. `requirements.md`、`design.md`、`implementation-plan.md`を先に読み直す。
2. このログと実装計画書の未完了チェック項目、本番設定の有無を突き合わせる。
3. ユーザー承認が必要な外部設定を確認してから、Inspector接続へ進む。

## 再開計画：フェーズ3ローカル統合（2026-09-11）

- [x] 現行`/chat`のGeminiリクエスト・レスポンス契約とテストを再確認する
- [x] finance Workerの内部RPC（Service Binding相当）契約を設計する
- [x] `fukuchan-app`側へ家計ツールのfunction declarationとallowlist検証を追加する
- [x] Geminiのfunction call → finance Worker → function responseの往復を実装する
- [x] 家計以外の質問、ツール不正引数、MCP障害、staleデータの回帰テストを追加する
- [x] 要件定義書・設計書・実装計画書と`tasks/todo.md`の状態を更新する
- [x] `npm test`、dry-run、差分・秘密情報チェックを実行する

### 再開時の前提

- Cloudflare本番D1/KV、GitHub OAuth secrets、実クライアント接続はこの計画では変更しない。
- Geminiへ渡すのは質問に必要な集計結果・期間・鮮度・`as_of`だけとし、明細・口座番号・OAuth情報は渡さない。
- Service Bindingが未設定のローカル環境でも、既存の一般会話と安全なフォールバックを維持する。

### Review（フェーズ3ローカル統合）

- `workers/finance-mcp/src/contracts.js`を追加し、MCP・RPC・Geminiの5ツール名、引数スキーマ、RPCメソッド対応を一元化した。
- finance Workerへ`WorkerEntrypoint`の5 RPCメソッドを追加し、RPC境界でも入力を検証するようにした。
- root Workerへ`FINANCE_SERVICE` bindingと`FINANCE_TOOL_ENABLED`フラグを追加した。フラグfalseは旧CSV経路、trueかつbinding欠落は503で停止する。
- Geminiのfunction callを最大2ラウンド・1ラウンド最大5件で処理し、function responseへ同じcall idと固定エラーコードを返すようにした。
- `npm test`：57件すべて成功。root Worker・finance Workerのdry-run、`git diff --check`も成功した。
- 本番デプロイ、D1へのスキーマ・実データ投入、GitHub OAuth secrets、実クライアント接続、実データ同期は未実施。D1/KVリソース自体は後続作業で作成済み。

## 外部設定確認（2026-09-11）

状態: Wrangler認証待ちは解消済み。D1/KV作成以外の外部設定・デプロイは未実施。

- 初回確認ではローカルのWrangler認証トークンが期限切れだったが、ユーザーが対話ログインを完了し、`whoami`で対象アカウントを確認できた。
- 認証情報の値は取得・記録・表示していない。
- その後のD1/KV作成はユーザー承認を得て実施した。Secrets登録・本番設定・デプロイは引き続き承認を得てから行う。

## 外部設定確認の再開計画（2026-09-11）

- [x] 要件定義書・設計書・実装計画書を読み直し、必要な外部リソース名と設定項目を再確認する
- [x] Wranglerの認証アカウントと対象アカウントIDを読み取り確認する
- [x] D1データベースとKV namespaceを読み取り確認し、Wrangler設定のプレースホルダーとの差分を整理する
- [x] 変更・作成・デプロイを行わず、次に必要なユーザー承認事項をログへ記録する

### 確認結果

- `npx wrangler whoami`：OAuthログイン成功。対象アカウントを確認した。
- （作成前確認時点）`npx wrangler d1 list`：D1は0件。
- （作成前確認時点）`npx wrangler kv namespace list`：KV namespaceは0件。
- （作成前確認時点）`workers/finance-mcp/wrangler.toml`のD1/KV IDはゼロ値プレースホルダーだった。
- 作成前に必要だったユーザー承認を取得し、以下の作成作業を実施した。

### 作成結果（ユーザー承認後、2026-09-11）

- [x] D1 `fukuchan-finance`を作成する
- [x] KV namespace `OAUTH_KV`を作成する
- [x] 発行されたD1/KV IDを`workers/finance-mcp/wrangler.toml`へ反映する
- [x] finance Worker dry-runでD1/KVバインディングを確認する

確認内容（作成直後）:

- D1は作成済み・テーブル数0。KVは作成済み・保存データなし。
- この時点ではD1スキーマ・デモデータ、Secrets、GitHub OAuth App、Workerデプロイは未実施だった。

## リモートD1スキーマ適用（2026-09-11）

- [x] `workers/finance-mcp/schema.sql`にDROP・DELETE・UPDATEなどの既存データを破壊する命令がないことを確認する
- [x] `fukuchan-finance`へスキーマだけをリモート適用する
- [x] 適用後のテーブル一覧と件数を読み取り確認する
- [x] デモデータ、実データ、Secrets、Workerデプロイはこの作業では行わない

### Review

- `npx wrangler d1 execute fukuchan-finance --remote --file workers/finance-mcp/schema.sql`：11クエリ成功、6つのアプリ用テーブルを作成した。
- `sqlite_master`で`sync_runs`、`daily_summaries`、`monthly_summaries`、`category_daily_totals`、`category_totals`、`asset_summaries`を確認した（`_cf_KV`はCloudflare管理用テーブル）。
- 適用直後の6テーブルの行数はすべて0。デモデータ・実データはまだ投入していない状態だった。
- 検証時のUNION ALL集計はSQLiteのcompound SELECT制限で失敗したが、同じ確認をスカラーサブクエリで再実行し成功した。DBへの変更は発生していない。
- [ ] 新しいGitHub fine-grained PAT（対象repo限定、Contents read-only）へ更新
- [ ] 新しいGemini Auth keyへ更新
- [ ] 有効な資格情報で`/chat`正常系が200となることを確認

## リモートD1デモデータ投入（2026-09-11）

状態: 完了。実在しないfixtureのみを投入し、読み取り検証を行った。

- [x] `demo-data.sql`がINSERTのみで、DROP・DELETE・UPDATEを含まないことを確認する
- [x] `fukuchan-finance`へ架空デモデータをリモート投入する
- [x] 各テーブル件数と代表集計を読み取り確認する

### Review

- 投入元は`codex/issue-2-cloudflare-cicd`の`bb64747`に含まれる架空fixtureで、実在の家計情報は含まれない。
- 投入結果：`sync_runs` 1件、`daily_summaries` 22件、`monthly_summaries` 2件、`category_daily_totals` 22件、`category_totals` 4件、`asset_summaries` 3件。
- 月次集計は2026-08が収入300,000円・支出109,000円、2026-09が収入300,000円・支出138,000円として確認した。
- 資産集計は預金1,000,000円、投資信託500,000円、負債-200,000円として確認した。
- D1スキーマ・デモデータはCloudflare上に反映済み。Secrets、GitHub OAuth App、Workerデプロイ、`FINANCE_TOOL_ENABLED=true`への切り替えは未実施。
- MCP実装一式は`codex/issue-2-cloudflare-cicd`の`bb64747`から`main`へfast-forward統合済みである。

## main統合と回帰検証（2026-09-12）

- [x] `codex/issue-2-cloudflare-cicd`を`main`へfast-forward統合する
- [x] 退避していたデモ投入ログを統合後の`tasks/todo.md`へ戻す
- [x] 統合後に全テストとroot/finance Workerのdry-runを実行する

### Review

- `main`のHEADは`cb8714f`（実装統合後の作業ログコミット）。作業ツリーはクリーン。
- `npm test`：6ファイル、57テストすべて成功。
- root Worker dry-run：`FINANCE_SERVICE`（`FinanceMcpApi` entrypoint）と機能フラグfalseを確認。
- finance Worker dry-run：リモートD1とKVバインディングを確認。
- GitHub OAuth App、finance WorkerのSecrets、本番デプロイは完了。`FINANCE_TOOL_ENABLED=true`への切り替えと実クライアント接続は未実施。

## OAuth設定準備計画（2026-09-12）

- [x] 実装・設定・作業ログの状態をCloudflare上のD1/KV・デモデータと照合する
- [x] GitHub OAuthで必要な入力（Client ID/Secret、許可login、callback URL）を整理する
- [x] finance Worker専用`.dev.vars`をgitignoreへ追加し、Secrets投入手順を分離する
- [x] finance Workerのデプロイ履歴を読み取り確認する（未デプロイを確認）
- [x] finance Worker用`.dev.vars`の存在を値非表示で確認する（3項目設定済み、権限600へ変更済み）
- [x] GitHub OAuth Appを作成する（ユーザー操作）
- [x] `GITHUB_ALLOWED_LOGIN`とcallback URLをWrangler varsへ設定する
- [x] `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`COOKIE_ENCRYPTION_KEY`をWorkers Secretsへ登録する（値は会話へ貼らない）
- [x] finance Workerをdry-run後に本番デプロイする
- [x] MCP InspectorでOAuth接続と5ツールを確認する（実クライアント接続は別途）

### 設定メモ

- Worker名は`fukuchan-finance-mcp`。デプロイ後に確認したcallback URLは`https://fukuchan-finance-mcp.fukuchan-app.workers.dev/github/callback`で、GitHub OAuth Appの登録値と一致させている。
- 実装がGitHubへ要求するOAuth scopeは`read:user`のみ。許可loginは推測で設定せず、ユーザーが指定したGitHub loginを使う。

## 本日の作業ログ（2026-09-12）

状態: finance WorkerのOAuth設定・本番デプロイ・smoke testまで完了。次回は実OAuthクライアント接続から再開する。

### 今日完了したこと

- `codex/issue-2-cloudflare-cicd`のfinance MCP実装を`main`へfast-forward統合した。
- 統合後に`npm test`（57件）、root Worker dry-run、finance Worker dry-runを実行し、すべて成功した。
- リモートD1には架空デモデータを投入済みで、active syncと代表集計を確認した。
- GitHub OAuth Appの設定、許可login、callback URL、finance Worker Secretsを設定し、finance Workerを本番デプロイした。
- 本番smoke testで`/health`=200、未認証`POST /mcp`=401、OAuthパラメータなし`/authorize`=400を確認した。Dynamic Client Registrationの疎通確認後、一時テストクライアントは削除した。
- MCP Inspectorの初回OAuthでscope省略時の`invalid_scope`、再認証時の`Invalid authorization code format`を確認した。scope既定付与と、認可コードの区切り文字と衝突しないuserId形式を実装して再デプロイした。OAuthテスト9件が成功した。
- MCP InspectorでOAuth接続後、`get_monthly_summary`、`get_category_breakdown`、`compare_months`の実応答を確認した。食費は同期間で33,000円から55,000円へ22,000円（66.7%）増加した。
- MCP Inspectorで`get_data_freshness`、`get_monthly_summary`、`get_category_breakdown`、`compare_months`、`get_asset_summary`の5ツールすべての実応答を確認した。資産は総資産1,500,000円、負債200,000円、純資産1,300,000円だった。
- デモfixtureの月次9月支出138,000円と日次同期間合計148,000円に10,000円の差を検出した。実データ投入前に月次・日次集計の整合性を確認する。
- 変更後の`npm test`（57件）と`git diff --check`が成功した。
- 作業ログをコミットし、作業ツリーをクリーンにした。

### 次回に残っていること

- MCP Inspectorまたは実クライアントでOAuth接続と5ツールの実応答を確認する。
- デモfixtureの月次・日次集計差分（9月10,000円）を原因特定し、整合性を取る。
- root Workerを`FINANCE_TOOL_ENABLED=true`で再デプロイし、代表質問の新旧比較を行う。
- 検証後、手動CSVまたは固定upstream SQLiteの同期exporterへ進む。
- GitHubへのpush／Pull Request作成は、ユーザー確認後に行う。
