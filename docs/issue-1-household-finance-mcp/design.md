# 設計書：家計簿のMCP化

対応要件: [requirements.md](requirements.md)  
作成日: 2026-09-11  
状態: In progress（フェーズ1〜3の実装完了、Cloudflare認証・D1/KV作成・スキーマ適用・架空デモデータ投入・OAuth secrets設定・finance Workerデプロイ・MCP Inspector 5ツール確認・root Worker finance有効化・本番デモ自然文確認済み、実データ・実クライアント接続待ち。手動CSVなしの自動同期はADR-002で提案中、Cloudflare Secrets保管と1回の実ログインPoCのみ承認済み）

## 1. 設計結論

Money Forward MEの取得処理と、AIからの照会処理を分離する。

- **取得面**：信頼済みローカルホストで`mf-dashboard`のcrawlerを動かし、Money Forward MEからSQLiteへ取得する。
- **同期面**：必要な集計だけを検証済みSQLへ変換し、Cloudflare D1へ同期する。
- **提供面**：別Workerの`fukuchan-finance-mcp`が、GitHub OAuthで保護したD1読み取り専用の5つのRemote MCPツールを提供する。
- **アプリ連携**：既存`fukuchan-app`は、公開URLではなくCloudflare Service Bindingでfinance Workerの内部RPCを呼び、Geminiへは集計結果だけを渡す。

この構成なら、Money Forward MEのログイン情報をCloudflareやAIへ渡さず、外部MCPとふくちゃんトークの両方で同じ集計ロジックを利用できる。

手動CSVなしでMacのスリープに依存しない同期は、[ADR-002：手動CSVなしの家計データ自動同期](adr-002-automatic-sync.md)で別途提案している。ユーザー承認により、ADR-002の検証目的に限ってCloudflare Secrets保管と1回の実ログインPoCへ進む。ただしADRがAcceptedになるまで、本設計の採用構成（ローカル取得 + D1 + Remote MCP）、実データのD1投入、本番Cron有効化、ブラウザセッション永続化は変更しない。

## 2. 調査結果

### 2.1 参照実装の変化

| 対象 | 構成 | 本件での扱い |
|---|---|---|
| `mf-dashboard` v1 | GitHub ActionsでPlaywrightを動かし、SQLiteをリポジトリへ保存。MCPは`stdio`でローカルSQLiteを参照 | 旧MCPのツール設計を参考にするが、そのまま採用しない |
| `mf-dashboard` v2系 | ローカルDocker Composeで`web`・`crawler`・`cloudflared`を常時稼働。AIチャットはWebアプリ内蔵で、外部MCPは廃止 | crawlerとSQLiteを取得元として利用する候補 |
| 現行`fukuchan-app` | Cloudflare WorkerがPrivate GitHubのCSV等を取得し、全文をGeminiへ渡す | 家計部分だけを構造化ツール呼び出しへ変更する |

旧v1 MCPは`better-sqlite3`に合わせたCJSビルドと`stdio`を前提にしている。一方、CloudflareのRemote MCPはStreamable HTTPで提供できる。プロトコルと実行環境が異なるため、ツールの目的だけを引き継ぎ、実装はWorker + D1向けに作り直す。

### 2.2 Money Forward製品の区別

Money Forwardが公式公開しているAPI・MCPの中心はMoney Forward クラウド会計等の事業者向け製品である。本件の対象は個人向けMoney Forward MEであり、同じAPIを流用できる前提にしない。

## 3. ADR-001：全体アーキテクチャ

### 選択肢

| 案 | 概要 | 長所 | 短所 | 判断 |
|---|---|---|---|---|
| A. v1をそのまま導入 | 旧stdio MCPとSQLiteをローカルで使う | 最短でMCPツールを試せる | upstreamが旧版、外部接続不可、既存Workerと統合しにくい | 不採用 |
| B. v2ダッシュボードだけを使う | 内蔵AIチャットを利用 | upstreamの現行構成に沿う | ふくちゃん・外部MCPと別UIになる | 補助用途 |
| C. Workerへcrawlerも移植 | Browser Rendering等で取得から提供までCloudflare化 | 常時起動ホスト不要 | ログイン・OTP・画面操作・永続セッションが複雑。障害時の切り分けが難しい | 不採用 |
| D. ローカル取得 + D1 + Remote MCP | crawlerはローカル、照会はCloudflare | 認証情報を分離、Workerと相性がよい、外部MCPにも対応 | ローカルホスト運用と同期処理が必要 | **採用** |
| E. 手動CSV + Remote MCP | 現行CSVをMCP化 | 最小構成でPoC可能 | 自動更新・資産照会ができない | Phase 0の代替 |

### 決定理由

- Money Forward MEの認証情報とOTPをCloudflareへ置かない。
- crawler障害が起きても、直前の成功データをD1から提供できる。
- Remote MCPと既存アプリ内部利用で、同じクエリ実装を共有できる。
- D1の構造化クエリにより、家計データ全体を毎回LLMへ送る必要がない。
- 取得側と提供側を独立して更新・ロールバックできる。

### 現時点の外部環境確認（2026-09-11）

- Wrangler OAuthで対象Cloudflareアカウントへのログインを確認した。
- ユーザー承認後、`fukuchan-finance`用の本番D1と`OAUTH_KV` namespaceを作成した。D1には架空のデモスナップショット1件を投入済みで、KVは空の状態である。
- 発行されたD1/KV IDを`workers/finance-mcp/wrangler.toml`へ反映し、finance Workerのdry-runで両バインディングを確認した。
- `schema.sql`と架空の`demo-data.sql`をリモートD1へ適用済み。6つのアプリ用テーブルにデモデータが入り、実データは未投入である。OAuth secretsを登録し、finance Workerを本番デプロイ済みである。

## 4. システム構成

```text
┌────────────────────────────────────────────┐
│ 信頼済みローカルホスト                       │
│                                            │
│  1Password ──認証情報/OTP──┐               │
│                            ▼               │
│  mf-dashboard crawler ──> SQLite           │
│                            │               │
│                            ▼               │
│  finance-exporter（抽出・検証・SQL生成）      │
└────────────────────────────┬───────────────┘
                             │ scoped Cloudflare API token
                             │ wrangler d1 execute --remote
                             ▼
┌────────────────────────────────────────────┐
│ Cloudflare                                  │
│                                            │
│  D1: fukuchan-finance                      │
│          │                                 │
│          ▼                                 │
│  Worker: fukuchan-finance-mcp              │
│   ├─ /mcp（GitHub OAuth必須、Streamable HTTP）  │
│   └─ internal RPC（Service Binding専用）     │
│          ▲                       ▲          │
└──────────┼───────────────────────┼──────────┘
           │ OAuth                 │ Service Binding
           │                       │
  Claude / ChatGPT等        Worker: fukuchan-app
                            └─ /chat → Gemini tool calling
```

## 5. コンポーネント設計

### 5.1 `mf-dashboard` crawler

- 調査時点の現行リリースを固定して利用する。
- Docker Composeで信頼済みホスト上に配置する。
- Money Forward MEのID、パスワード、OTPは1Password Service Accountから取得する。
- 取得後のSQLiteはローカル保存し、Publicリポジトリへコミットしない。
- upstream更新は、ステージングDBで取得と集計の一致を確認してから適用する。

### 5.2 `finance-exporter`

配置候補: `tools/finance-sync/`

責務:

1. SQLiteを読み取り専用で開く。
2. 対象テーブル・カラムの存在を検証する。
3. 日次、月次、カテゴリ別、資産別の集計を行う。
4. 金額・件数・期間・重複を検証する。月次集計と日次集計の合計も照合する。
5. 新しい`sync_id`を付けたSQLファイルを一時ディレクトリへ生成する。
6. D1へ投入し、全処理成功後にその`sync_id`をactiveへ切り替える。
7. 一時SQLを削除する。SQLや標準出力へ金融明細を出さない。

自動同期が利用できるまでのOption 2として、`workers/finance-sync/src/csv-importer.js`が月次CSVまたはMoney Forwardの「収入・支出詳細」CSVを`monthly_only`スナップショットへ変換する。月次CSVは`年月・カテゴリ・金額・メモ`、詳細CSVは`日付・金額・大項目`を使い、任意の`方向`にも対応する。詳細CSVの符号から収入・支出を判定し、振替・対象外行を除外する。`メモ`、内容、金融機関、IDなどの余分な列はパーサーが読み飛ばし、スナップショットと生成SQLには含めない。`tools/finance-sync/import-csv.mjs`はUTF-8とShift_JISを自動判定し、ローカルファイルを読み、件数だけを標準出力へ出し、一時SQLを明示された出力先へ生成する。WranglerのD1 SQL実行では明示的な`BEGIN/COMMIT`が拒否されるため、実行前にSQLを検証し、新syncのactive化を旧activeのsuperseded化より先に行う。

`monthly_only`では日次・日次カテゴリ行を作らず、月次とカテゴリの合計一致だけを検証する。D1の`compare_months`は日次行がない場合に`unsupported_granularity`で停止するため、月次全期間を同期間比較へ誤用しない。実CSVはこの作業ツリーへ保存せず、合成fixtureでCLIとlocal D1への投入を検証する。remote D1への実CSV投入は別途承認まで行わない。

ローカル実行の概念例:

```text
finance-sync validate --db <local-sqlite>
finance-sync export --db <local-sqlite> --output <temporary-sql>
wrangler d1 execute fukuchan-finance --remote --file <temporary-sql>
finance-sync verify --remote
```

コマンド名と引数は実装時に確定する。秘密値や実パスはドキュメントへ記載しない。

### 5.3 Cloudflare D1

DB名: `fukuchan-finance`（案）

P0は集計データだけを保存し、取引摘要・口座番号・カード番号は保存しない。

#### テーブル

```sql
CREATE TABLE sync_runs (
  sync_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'failed', 'superseded')),
  source_max_date TEXT,
  daily_count INTEGER NOT NULL DEFAULT 0,
  monthly_count INTEGER NOT NULL DEFAULT 0,
  category_count INTEGER NOT NULL DEFAULT 0,
  asset_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);

CREATE TABLE monthly_summaries (
  sync_id TEXT NOT NULL,
  month TEXT NOT NULL,
  income_yen INTEGER NOT NULL,
  expense_yen INTEGER NOT NULL,
  balance_yen INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  PRIMARY KEY (sync_id, month)
);

CREATE TABLE daily_summaries (
  sync_id TEXT NOT NULL,
  date TEXT NOT NULL,
  income_yen INTEGER NOT NULL,
  expense_yen INTEGER NOT NULL,
  balance_yen INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  PRIMARY KEY (sync_id, date)
);

CREATE TABLE category_totals (
  sync_id TEXT NOT NULL,
  month TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  category TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  PRIMARY KEY (sync_id, month, direction, category)
);

CREATE TABLE category_daily_totals (
  sync_id TEXT NOT NULL,
  date TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  category TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  PRIMARY KEY (sync_id, date, direction, category)
);

CREATE TABLE asset_summaries (
  sync_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  PRIMARY KEY (sync_id, as_of_date, asset_type)
);
```

#### スナップショット切り替え

- 新しい同期は`staging`として別`sync_id`へ挿入する。
- 件数・合計値・期間の検証が通ったら、旧activeを`superseded`、新syncを`active`へ変更する。
- 旧activeの切り替えと新syncのactive化は、staging行・集計行の投入を含む1回のD1 batchで行う。batch失敗時は全体ロールバックされ、旧activeを維持する。
- MCPは`status = 'active'`の1件だけを参照する。
- 同期失敗時は旧activeを維持する。
- 保持期間はactive + 直前2世代を基本とし、それ以前は定期削除する。

#### 集計粒度

- `daily_summaries`と`category_daily_totals`を正確な同期間比較の正本とする。
- `monthly_summaries`と`category_totals`は全月照会と高速化のために保持し、日次データの合計と一致することを同期時に検証する。
- P0では日次の集計値だけを保存し、取引明細そのものは保存しない。日次データが作れない入力は、同期間比較を有効にした同期として受け入れない。

### 5.4 `fukuchan-finance-mcp` Worker

既存アプリとは別Workerとして同じリポジトリ内に配置する。

配置案:

```text
workers/finance-mcp/
├── src/index.js
├── src/queries.js
├── src/mcp.js
├── src/contracts.js     # MCP・RPC・Geminiで共有する入力契約
├── src/oauth.js
├── test/
└── wrangler.toml
```

公開面:

- `POST /mcp`：Streamable HTTP MCP。OAuth必須。
- OAuth関連エンドポイント：採用するプロバイダーに応じて設定。
- `/oauth/register`：MCP Inspector等のOAuthクライアント向けDynamic Client Registration。Provider標準のredirect URI・PKCE検証を利用する。
- 認証不要のデータエンドポイントは作らない。
- ヘルスチェックはデータやツール一覧を返さず、稼働状態だけを返す。

実装は次の公式パッケージを利用する。

- `@modelcontextprotocol/server` v2：`McpServer`、`createMcpHandler`、Streamable HTTP transport
- `@cloudflare/workers-oauth-provider`：GitHub OAuth後のBearer検証、KVへのトークン・grant保存、`ctx.props`提供
- `zod` v4：ツール入力の標準スキーマとJSON Schema変換

`OAuthProvider`の`apiHandler`には`WorkerEntrypoint`クラスを渡し、`ctx.props`からユーザー情報を取得する。MCP SDKへは、トークン値そのものを渡さず、認証済み主体を表す最小の`AuthInfo`（`clientId`、`scopes`、`extra.userId`）だけを`handler.fetch(request, { authInfo })`で渡す。ツールの実行はD1の読み取りクエリに限定し、ユーザー情報を結果へ含めない。

内部面:

- `WorkerEntrypoint`のRPCメソッドとしてP0の5照会を公開する。
- メソッド名は`getDataFreshness`、`getMonthlySummary`、`getCategoryBreakdown`、`compareMonths`、`getAssetSummary`とし、RPC境界でも共有zodスキーマを適用する。呼び出し側はWranglerの`entrypoint = "FinanceMcpApi"`で名前付きentrypointへ接続する。
- RPCは`fukuchan-app`のService Bindingからだけ利用する。
- MCPツールとRPCは同じ`queries.js`を呼び、集計ロジックを二重実装しない。

### 5.5 `fukuchan-app` Worker

`/chat`の家計質問だけをツール利用へ切り替える。

処理フロー:

1. 既存のCookie認証、入力制限、レート制限を実行する。
2. Geminiへ家計ツールのfunction declarationを渡す。
3. Geminiがツールを選んだ場合、名前と引数をallowlistで検証する。
4. `env.FINANCE_SERVICE.<method>()`を呼ぶ。
5. 構造化結果をGeminiへfunction responseとして返す。
6. Geminiの最終回答にデータ基準日時を含める。

家計質問に対して、従来の`knowledge/finance.csv`を同時にプロンプトへ入れない。新旧データが矛盾するため、移行期間中は機能フラグでどちらか一方だけを利用する。

機能フラグは`FINANCE_TOOL_ENABLED`とし、`true`でも`FINANCE_SERVICE`が無い場合は503で停止する。両方が設定された場合だけGeminiへ5つのfunction declarationを渡す。function callの`name`と`args`は`contracts.js`でallowlist・zod検証し、RPC失敗は固定エラーコードとしてfunction responseへ返す。最大2ラウンド、1ラウンド最大5呼び出しとする。

### フェーズ3ローカル実績（2026-09-11）

- `contracts.js`をMCP Workerと`fukuchan-app`から共有し、5ツールの入力契約・Gemini declaration・RPCメソッド対応を一元化した。
- `FinanceMcpApi`を名前付きentrypointとして公開し、`fukuchan-app`の`FINANCE_SERVICE`からRPCで呼び出せるWrangler設定にした。
- Gemini RESTの`generateContent`でfunction callを検出し、RPC結果を同じcall id付きの`functionResponse`へ変換する2段階フローを実装した。
- 最終回答にツール結果の基準日時と鮮度を補足し、モデルが省略した場合も回答から確認できるようにした。
- 機能フラグfalse時の旧CSV経路と、true時の`finance.csv`除外、binding欠落時の503をテストで固定した。

## 6. MCPツール契約

### 共通出力

```json
{
  "data": {},
  "meta": {
    "syncId": "opaque-id",
    "asOf": "2026-09-11T06:30:00+09:00",
    "freshness": "fresh",
    "currency": "JPY"
  }
}
```

`freshness`は`fresh`、`stale`、`expired`のいずれかとする。

### `get_data_freshness`

- 入力：なし
- 出力：最終成功日時、同期元の最終日、対象月、件数、鮮度状態
- 用途：他のツール実行前の確認、管理者の障害確認

### `get_monthly_summary`

- 入力：`month`（`YYYY-MM`、省略時はデータ上の最新月）
- 出力：収入、支出、収支、取引件数
- 対象月がなければ空結果と利用可能月を返す。近い月へ自動補正しない。

### `get_category_breakdown`

- 入力：`month`、`direction`（`income`または`expense`）、`limit`（既定10、最大20）
- 出力：金額降順のカテゴリ一覧、合計、その他

### `compare_months`

- 入力：`base_month`、`compare_month`、`category`省略可、`direction`（既定`expense`）、`period_mode`（既定`auto`）、`as_of`省略可
- `period_mode=auto`では、`base_month`がAsia/Tokyoの現在月なら当月1日〜当日と比較月の1日〜同日を使い、それ以外は両月の全期間を使う。
- `period_mode=month_to_date_same_day`は明示的に同日までを比較し、`period_mode=full_month`は両月の月初〜月末を比較する。
- 比較先に同日が存在しない場合は比較先の月末へ終了日を丸める。未来日・同期元の最終取得日より後の日は集計に含めない。
- 出力：各期間の開始日・終了日、収入・支出・収支の差額と割合、主要カテゴリ差分、適用した`period_mode`
- 分母が0の場合、割合は`null`とし無限大表現を返さない。

#### 同期間比較の処理例

```text
現在日: 2026-09-11 (Asia/Tokyo)
質問: 今月の食費は先月に比べてどう？
入力: base_month=2026-09, compare_month=2026-08,
      category=食費, direction=expense, period_mode=auto
比較: 2026-09-01〜09-11 と 2026-08-01〜08-11
```

日次集計がない場合は`unsupported_granularity`を返す。月次全期間の値を代用して回答の見かけ上の正確さを優先しない。

### `get_asset_summary`

- 入力：`as_of`省略可
- 出力：資産タイプ別金額、総資産、総負債、純資産
- P0では金融機関名、口座番号、個別銘柄名を返さない。

## 7. 認証・認可

### 外部MCP

- OAuth 2.1対応を前提とする。
- 外部MCPはGitHub OAuthを採用する。GitHubの許可ユーザー／組織を`GITHUB_ALLOWED_LOGIN`（複数指定時はカンマ区切り）で制限し、取得失敗・未設定・不一致はfail-closedとする。
- OAuth Providerが発行するscopeは`mcp:read`だけとし、書き込み権限を定義しない。
- 家族のGoogleアカウントを許可する場合はCloudflare Accessを候補とする。
- 認可後もP0ツールは読み取り専用で、write scopeを定義しない。
- OAuthトークン、client secret、Cookie暗号鍵はWorkers Secretsまたは専用KVへ保存する。

### Worker間

- `fukuchan-app`からfinance WorkerへService Binding RPCを使う。
- 公開インターネットを経由する共有APIキー方式は採用しない。
- finance Workerは呼び出し元アプリの既存PIN認証を信用するのではなく、Service Bindingで到達経路そのものを限定する。

### 同期用

- D1への同期用Cloudflare API tokenは、対象アカウント・対象操作へ限定する。
- アプリのデプロイトークンと共用しない。
- トークンはローカルの秘密管理へ保存し、生成SQL・ログ・Gitへ含めない。

## 8. データ保護

### Cloudflareへ同期する

- 月次の収入・支出・収支
- カテゴリ別集計
- 資産カテゴリ別集計
- 件数、対象期間、同期時刻、同期状態

### P0では同期しない

- Money Forward MEの認証情報とOTP
- ブラウザセッション
- 口座番号、カード番号
- 取引摘要、店舗名、個人名
- 個別の証券銘柄と保有数量

### LLMへ渡す

- ユーザーの質問
- 選択されたツールの入力
- その質問に必要なツール結果
- 最終同期日時

D1全件、同期ログ、無関係なカテゴリは渡さない。

## 9. エラー処理

| 状況 | 同期側 | MCP/アプリ側 |
|---|---|---|
| Money Forwardログイン失敗 | 新syncをactiveにしない。`AUTH_FAILED`を記録 | 直前activeを返し、stale時は警告 |
| 画面構造変更 | `SCHEMA_CHANGED`で停止 | 直前activeを返す |
| SQLiteスキーマ変更 | exporter検証で停止 | 直前activeを返す |
| D1投入失敗 | 再試行可能。一時SQLを保護して終了 | 直前activeを返す |
| active syncなし | なし | データを推測せず503相当のツールエラー |
| OAuth失敗 | 影響なし | 認証エラー。データを返さない |
| Gemini tool引数不正 | 影響なし | ツールを呼ばず、再試行または安全なエラー |

## 10. 監視

- 同期：成功/失敗、所要時間、行数、最終成功時刻、エラーコード
- MCP：ツール名、成功/失敗、処理時間。引数と結果の金額は記録しない
- アプリ：家計ツール呼び出し成功率、stale警告回数。質問本文は記録しない
- アラート条件：24時間同期なし、連続2回失敗、activeなし、認証失敗急増

P0では専用監視基盤を導入せず、Cloudflareのログとローカル同期結果を利用する。通知はP1とする。

## 11. テスト方針

### exporter

- fixture SQLiteから期待するSQL・集計が作られる。
- 振替、取消、空カテゴリ、負数、月跨ぎ、重複を正しく扱う。
- スキーマ不一致時に同期しない。
- 金融明細がログに出ない。

### finance Worker

- 5ツールの入力スキーマと出力契約。
- 任意SQLや未定義ツールを実行できない。
- 対象月なし、0除算、stale、activeなしのエラー契約。
- OAuth未認証時にデータを返さない。
- Streamable HTTPの`POST /mcp`で`initialize`、`tools/list`、`tools/call`の契約を確認する。`Origin`不正、JSON以外のbody、未認証は拒否する。modern envelopeでのProtocol-Version不整合はSDKに拒否させる。
- GitHub OAuthの許可ユーザー・未設定・GitHub API失敗をfail-closedで確認する。OAuthの実トークン値はfixtureへ保存しない。
- Service Binding RPCとMCPが同じ結果を返す。

### fukuchan-app

- 代表質問10件で正しいツールを選ぶ評価テスト。
- 家計以外の質問でfinance toolを呼ばない。
- ツール結果にない金額を回答へ追加しない。
- 回答へ基準日時が含まれる。
- 既存`/auth`、一般ナレッジ、雑談機能に回帰がない。

## 12. ロールアウト・ロールバック

1. デモデータでMCPとService Bindingを構築する。
2. 手動CSVをD1へ入れ、現行回答と比較する。
3. 実データ同期を有効化するが、ふくちゃんは旧CSVを使い続ける。
4. 管理者だけ機能フラグで新ツール回答を有効化する。
5. 7日間比較し、金額・鮮度・エラーに問題がなければ全利用者へ切り替える。
6. 旧`finance.csv`はさらに14日保持してから、チャットの読込対象から外す。

ロールバックは、機能フラグを旧CSVへ戻すだけで行える。D1やMCP Workerを削除せず、原因調査中も直前データを保持する。

## 13. 将来見直す条件

- P0集計では答えられない質問が全家計質問の10%を超えたら、限定的な取引検索をP1へ追加する。
- D1同期量やクエリ量がプラン上限へ近づいたら、保持期間と集計粒度を見直す。
- Money Forward MEが個人向け公式APIを提供したら、crawlerを公式APIへ置き換える。
- upstreamのcrawler保守が停止したら、手動エクスポート経路または別データソースへ切り替える。

## 14. 参考資料

- [`mf-dashboard` v1 MCP README](https://github.com/hiroppy/mf-dashboard/blob/v1/apps/mcp/README.md)
- [`mf-dashboard`現行セットアップ](https://github.com/hiroppy/mf-dashboard/blob/main/docs/setup.md)
- [Cloudflare Remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Cloudflare Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare D1 Workers Binding API](https://developers.cloudflare.com/d1/worker-api/)
- [Cloudflare D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Gemini API function calling](https://ai.google.dev/gemini-api/docs/function-calling)
