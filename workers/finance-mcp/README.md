# fukuchan-finance-mcp

家計の集計値だけを提供するRemote MCP Workerです。フェーズ1〜3の実装（D1 query、Remote MCP、GitHub OAuth、Service Binding RPC）と、リモートD1への架空デモデータ投入が完了しています。本番OAuth・実データ同期・Workerデプロイには未接続です。

## 公開面

- `GET /health`：稼働状態だけを返す（認証不要）
- `POST /mcp`：Streamable HTTP。OAuth Bearerと`mcp:read` scopeが必要
- `GET /authorize`：GitHub OAuth認可へリダイレクト
- `GET /github/callback`：GitHub loginを許可リストと照合してOAuth grantを発行
- `POST /oauth/token`：OAuth Providerのtoken endpoint
- `POST /oauth/register`：MCPクライアントのDynamic Client Registration

## Service Binding RPC

`fukuchan-app`からの内部呼び出し用に、`WorkerEntrypoint`へ次の5メソッドを公開しています。いずれもMCPと同じ`queries.js`を使い、読み取り専用です。

- `getDataFreshness({})`
- `getMonthlySummary({ month? })`
- `getCategoryBreakdown({ month, direction?, limit? })`
- `compareMonths({ base_month, compare_month, category?, direction?, period_mode?, as_of? })`
- `getAssetSummary({ as_of? })`

RPC境界でも共有zodスキーマを適用します。`fukuchan-app`側は`FINANCE_TOOL_ENABLED=true`のときだけこのRPCをGemini function callingから利用し、falseの場合は旧`finance.csv`経路を使います。

## ローカル確認

```sh
npx wrangler d1 execute fukuchan-finance --config workers/finance-mcp/wrangler.toml --local --persist-to /tmp/fukuchan-finance-d1 --file workers/finance-mcp/schema.sql
npx wrangler d1 execute fukuchan-finance --config workers/finance-mcp/wrangler.toml --local --persist-to /tmp/fukuchan-finance-d1 --file workers/finance-mcp/demo-data.sql
npx wrangler dev --config workers/finance-mcp/wrangler.toml --local
```

GitHub OAuthの実ログインを行うには、gitignore済みの`workers/finance-mcp/.dev.vars`へ次の値を設定します。値はgitへ保存しません。

```text
GITHUB_CLIENT_ID=<GitHub OAuth App client ID>
GITHUB_CLIENT_SECRET=<GitHub OAuth App client secret>
COOKIE_ENCRYPTION_KEY=<ランダムな十分長い値>
GITHUB_OAUTH_CALLBACK_URL=http://localhost:8787/github/callback
```

`GITHUB_ALLOWED_LOGIN`はWranglerの変数です。複数ユーザーはカンマ区切りで指定します。GitHub OAuth Appのcallback URLは設定値と完全一致させてください。

ブラウザ型MCPクライアントから`Origin`ヘッダー付きで接続する場合は、許可するオリジンを`MCP_ALLOWED_ORIGINS`へカンマ区切りで設定します。未設定時は同一オリジン以外を403で拒否します。CLI型クライアントなど`Origin`なしの接続はこのチェックの対象外です。

## 本番設定（ユーザー承認後）

1. D1/KVは作成済みで、`wrangler.toml`へ実IDを設定済みである。
2. `GITHUB_ALLOWED_LOGIN`、`GITHUB_OAUTH_CALLBACK_URL`、必要な`MCP_ALLOWED_ORIGINS`、本番URLをWrangler varsへ設定する。
3. `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`COOKIE_ENCRYPTION_KEY`をWorkers Secretsへ投入する。
4. `schema.sql`と架空`demo-data.sql`は適用済み。実データ同期時はexporterが検証した集計SQLだけを投入する。
5. `npx wrangler deploy --config workers/finance-mcp/wrangler.toml --dry-run`後に本番デプロイする。

本番のD1/KV ID、OAuth secret、金融データはこのリポジトリへ書きません。初回デプロイ時は`npx wrangler deploy --config workers/finance-mcp/wrangler.toml --secrets-file workers/finance-mcp/.dev.vars`を使用し、秘密値を会話やログへ貼り付けないでください。実データ同期、実クライアント接続、Service Bindingの本番有効化は未実施です。
