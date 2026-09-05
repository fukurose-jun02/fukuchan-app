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

現在は手動デプロイで運用している。CI/CD（GitHub Actions経由の自動デプロイ）は[Issue #2](https://github.com/fukurose-jun02/fukuchan-app/issues/2)として計画中、未着手。

```bash
npx wrangler deploy --secrets-file .dev.vars
```

コードとシークレット（`GEMINI_API_KEY`・`GITHUB_TOKEN`・`WORKER_PIN`・`AUTH_TOKEN_SECRET`）が1回の操作でまとめて本番（`https://fukuchan-app.fukuchan-app.workers.dev`）に反映される。

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
