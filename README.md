# ふくちゃんトーク

家族の秘書フクロウ「ふく」とチャットできるWebアプリ。家計・保険・契約・記念日などの家族情報をAIに質問できる。

🌐 **公開URL**: https://fukuchan-app.fukuchan-app.workers.dev/
（旧URL `https://fukurose-jun02.github.io/fukuchan-app/` は新URLへの自動転送ページになっている）

---

## 概要

「ふくちゃんトーク」は、家族専用のAIアシスタントアプリ。LINEのようなチャットUIで、フクロウキャラクター「ふく」に話しかけると、家族に関する情報を答えてくれる。

### 主な用途

| カテゴリ | 例 |
|---|---|
| 家計 | 「今月の家計を教えて」 |
| 保険 | 「保険の情報を教えて」 |
| 契約 | 「インターネットの契約を教えて」 |
| 記念日 | 「近い誕生日はある？」 |

---

## システム構成（2026年9月〜、Cloudflare Workers）

フロントエンドとバックエンドは1つのCloudflare Workerに統合されている（同一オリジンのためCORS設定が不要）。設計の経緯は[docs/design.md](docs/design.md)を参照。

```
┌─────────────────────────────────────────┐
│           ユーザーのブラウザ              │
│  ・PIN入力画面                           │
│  ・チャットUI                            │
│  ・会話履歴管理（メモリ内）                │
└───────────────────┬─────────────────────┘
                    │ HTTPS
                    ▼
┌─────────────────────────────────────────┐
│  Cloudflare Workers (fukuchan-app)      │
│  ・静的ファイル配信 (public/)             │
│  ・POST /auth  … PIN照合・Cookie発行     │
│  ・POST /chat  … 会話処理・Gemini呼び出し │
│  ・GET  /health                         │
└─────────────────────────────────────────┘
                    │
                    ▼
  GitHub Private Repo（ナレッジ）+ Gemini API

家計機能は別Worker `fukuchan-finance-mcp` とD1へ分離し、外部MCP接続はGitHub OAuthで保護する。ふくちゃん本体は`FINANCE_SERVICE`のService Binding経由で同じ集計queryを呼び、Gemini function callingで家計質問に利用できる（`FINANCE_TOOL_ENABLED=true`で有効化）。
```

旧構成（GitHub Pages + Google Cloud Run）は移行後2週間、ロールバック用に並行稼働させている。

### ファイル構成

```
fukuchan-app/
├── public/                # Cloudflare Workersが配信する静的ファイル
│   ├── index.html          # アプリ本体（全コードが1ファイル）
│   └── images/
│       └── fuku-icon.png   # ふくちゃんのアイコン画像
├── src/
│   └── index.js           # バックエンドAPI（/auth・/chat・/health）
├── workers/finance-mcp/    # Issue #1：家計MCP（フェーズ1〜3実装、架空デモD1反映済み・未デプロイ）
│   ├── src/index.js        # OAuth Provider + Worker entrypoint
│   ├── src/mcp.js          # Streamable HTTP・5つの読み取りツール
│   ├── src/contracts.js    # MCP・RPC・Geminiで共有する入力契約
│   ├── src/oauth.js        # GitHub OAuth認可・callback
│   ├── src/queries.js      # D1読み取り専用query層
│   ├── src/*.test.js       # query/MCP/OAuth契約テスト
│   ├── README.md           # ローカル・本番設定手順
│   ├── schema.sql          # 日次・月次・カテゴリ・資産スキーマ
│   └── demo-data.sql       # 実在しない架空データ
├── wrangler.toml          # Cloudflare Workers設定
├── index.html             # 旧GitHub Pages向け（現在は新URLへの転送ページ）
└── docs/                  # 要件定義・設計・実装計画
```

### API

- **POST /auth**：PINを照合し、成功時に認証用Cookie（`HttpOnly; Secure; SameSite=Strict`、有効期限7日）を発行
- **POST /chat**：会話処理。`/auth`で発行されたCookieが必要
  ```json
  {
    "message": "ユーザーのメッセージ",
    "history": [
      { "role": "user", "content": "..." },
      { "role": "model", "content": "..." }
    ]
  }
  ```
  レスポンス：`{ "reply": "ふくちゃんの返答" }`
- **GET /health**：ヘルスチェック（認証不要）

### 家計 Remote MCP / ふくちゃん統合（フェーズ2〜3）

- Worker設定：[`workers/finance-mcp/wrangler.toml`](workers/finance-mcp/wrangler.toml)
- エンドポイント：`POST /mcp`（OAuth Bearer必須、Streamable HTTP）
- OAuth：GitHub OAuth（許可loginを`GITHUB_ALLOWED_LOGIN`で制限）
- 公開ツール：`get_data_freshness`、`get_monthly_summary`、`get_category_breakdown`、`compare_months`、`get_asset_summary`
- データ：D1の集計値のみ。取引摘要、口座番号、認証情報、任意SQLは扱わない。
- ふくちゃん統合：`FINANCE_TOOL_ENABLED=true`かつ`FINANCE_SERVICE`が設定された場合だけ、Geminiが5つの家計functionを選択し、Service Binding RPCで実行する。旧`finance.csv`は同時にGeminiへ渡さない。
- 現在は契約テストと架空デモD1まで。finance Workerの本番OAuth secrets、実クライアント接続、本番有効化、実データ同期は未実施。

ローカル契約テストは`npm test -- --run workers/finance-mcp/src/mcp.test.js workers/finance-mcp/src/oauth.test.js`で実行する。本番へ接続するには、Wranglerの`OAUTH_KV`、D1 ID、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`COOKIE_ENCRYPTION_KEY`、許可login、GitHub OAuth callback URLを環境ごとに設定する。値はリポジトリへ保存しない。

---

## フロントエンド設計

### PIN認証

アプリ起動時にPIN認証画面が表示される。

- 4桁のPINを入力すると`/auth`エンドポイントに送信され、サーバー側（Worker）で照合される
- 正しければCookieが発行され、チャット画面に進める
- 3回連続で間違えると30秒ロック（見た目上のUX。実効的なブルートフォース対策はサーバー側のレート制限）
- 正解PINはフロントエンドのコードに含まれていない（以前はコード直書きだったが、`/auth`方式への移行時に廃止した）

### チャット画面

- **デザイン**: スマートフォン向けのチャットUIをベースに、最大幅480pxで中央配置
- **会話履歴**: JavaScriptのメモリ内に保持（最大40ターン）。ページをリロードすると消える
- **送信方法**: 送信ボタン、またはEnterキー（Shift+Enterで改行）
- **クイック返信**: よく使う質問をボタン一発で送信できる

### レスポンシブ対応

| 画面幅 | 表示 |
|---|---|
| 480px以下 | 全画面チャット |
| 481px以上 | 中央に浮かんだカード形式（角丸、影付き） |

---

## デプロイフロー（2026年9月〜）

GitHub Actionsが契約テストを実行し、`main`ブランチへのpush時はテスト成功後にCloudflare Workersへ自動デプロイする。Pull Requestではデプロイせず、契約テストだけを実行する。

GitHub ActionsにはCloudflareへのデプロイ専用認証情報（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）のみを登録する。アプリが使用する4つの秘密情報はCloudflare Workers Secretsを正本とし、GitHubには複製しない。

```bash
npm test
npm run deploy
```

初回構築時や秘密情報の更新時だけ、管理者がローカルから`npx wrangler deploy --secrets-file .dev.vars`を実行する。通常のCI/CDは既存のWorkers Secretsを保持したままコードを更新する。

---

## セキュリティ上の注意点

| 項目 | 内容 |
|---|---|
| PIN認証 | `/auth`でサーバー側が照合。正解PINはコードに含まれない |
| ブルートフォース対策 | `/auth`へのレート制限（60秒窓・5回・IP単位）。拠点分散カウンタのため厳密な総当たり防止ではなく、抑止レベルであることは残余リスクとして受容している |
| 秘密情報 | Cloudflare Workers Secretsで管理。コード・リポジトリには含まれない |
| ナレッジ取得失敗時 | fail-closed（502を返し処理を中断） |
| リポジトリ | publicのため、コード・画像・履歴が全て公開。ナレッジ（家族情報）は別のPrivateリポジトリ（`fukuchan-knowledge`）で管理しており、こちらには含まれない |

本アプリは家族内の利便性を目的としたツールであり、詳細な設計判断・残余リスクは[docs/design.md](docs/design.md)を参照。
