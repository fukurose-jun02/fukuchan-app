# 要件定義書：Cloudflareへのインフラ移行

関連Issue: [fukuchan-knowledge#3](https://github.com/fukurose-jun02/fukuchan-knowledge/issues/3)（背景整理：[#2](https://github.com/fukurose-jun02/fukuchan-knowledge/issues/2)）

## 1. 背景・課題

現在「ふくちゃんトーク」は以下の構成で稼働している。

- フロントエンド：GitHub Pages（`fukurose-jun02/fukuchan-app`）
- バックエンド：Google Cloud Run上のFastAPI（`fukuchan-knowledge/backend/`）

フロント・バックエンドが別サービス（GitHub / Google Cloud）に分かれているため、CORS設定や秘密情報（APIキー・GitHubトークン）の管理がそれぞれ別の場所で必要になっている。Cloudflareに一本化することで、管理を1つのダッシュボードに集約したい。

## 2. 目的

- フロントエンドとバックエンドをCloudflare Workers 1つに統合し、同一アカウント・同一ダッシュボードで管理できるようにする
- 秘密情報の管理場所を集約する
- 現状の機能・挙動を変えずに、インフラのみを置き換える（機能追加はスコープ外）

## 3. スコープ

### 対象（移行する）
- バックエンドのホスティング：Cloud Run → Cloudflare Workers
- バックエンドの実装言語：Python（FastAPI） → JavaScript/TypeScript（Workers標準ランタイム）
- フロントエンドのホスティング：GitHub Pages → Cloudflare Workers（Static Assets機能で同一Workerが配信、`design.md` ADR参照）
- PIN認証：正解PINを公開JSに埋め込んだクライアント側のみの照合 → `/auth`エンドポイントでサーバー側（Worker）が照合し、トークンを発行する方式に変更（`design.md` 5章）
- 移行作業は作業ブランチで行い、切り替え確認が完了するまで現行のGitHub Pages配信（main）を壊さない（`design.md` 3章）

### 対象外（このタスクではやらない）
- 機能追加・UI変更（PIN認証・チャットUI・クイックボタン等は現状のまま）
- ナレッジファイル（`fukuchan-knowledge`）の管理方法の変更（引き続きGitHub Privateリポジトリ）
- データベース導入（現状ステートレスな構成を維持する）
- Phase 2で検討中のGoogle Drive PDF連携（別スコープ）

## 4. 現状の実装（移行前提の整理）

### バックエンド（`fukuchan-knowledge/backend/main.py`、105行）
- `POST /chat`：GitHub Contents APIから4ファイル（`family.md`・`contract.md`・`finance.csv`・`fukuchan.md`）を取得し、Gemini API（`gemini-2.5-flash`）にシステムプロンプト＋ナレッジ＋会話履歴＋当日日付とともに投げて応答を返す
- `GET /health`：ヘルスチェック
- ステートレス（会話履歴はフロントエンドから毎回送信される。サーバー側で保持しない）
- 環境変数：`GEMINI_API_KEY`・`GITHUB_TOKEN`・`GITHUB_REPO`
- 依存ライブラリ：FastAPI・httpx・pydantic・`google-generativeai`（Python SDK）

### フロントエンド（`index.html`、819行、単一ファイル）
- PIN認証（4桁）。`index.html:563`に`const CORRECT_PIN = '<現行PIN>';`と正解値が直書きされており、ページのソースを見れば誰でもPINが分かってしまう状態。バックエンド側にも認証は無い
- **注意**：現行PINは既にPublicリポジトリ`fukuchan-app`のGitHub Pages配信コード内で公開されており、コミット履歴に残り続ける（今後コードから削除しても、過去のコミットは誰でも閲覧可能）。AIからはローテーションを推奨したが、**家族で覚えやすい値を優先し、現行PIN（`1122`）をそのまま維持する方針とすることをユーザーが最終決定した**。これにより「知っている人にはPINによる保護が実質機能しない」という残余リスクを受容する（`design.md` 5章）
- チャットUI（`index.html:639`に`API_URL`をハードコードして`fetch`で`/chat`を呼び出し）
- GitHub Actionsワークフロー（`.github/workflows/pages.yml`）でmainブランチへのpush時に自動デプロイ

## 5. 要件

### 機能要件
- 移行後も `/chat`・`/health` のAPI仕様（リクエスト・レスポンス形式）は変更しない（フロントエンドの改修を最小限にするため）
- ナレッジ取得（GitHub Contents API）・Gemini API呼び出しのロジックは移行前と同じ結果を返すこと
- 日付の扱い（フロントエンドが`history`に日付ターンを追加し、バックエンドはそれをそのまま渡すだけ）という役割分担は変えない（詳細は`design.md` 4-1）

### セキュリティ要件（改訂）
- 正解PINをフロントエンドのコードから完全に排除する。フロントエンドはユーザーの入力値を送るだけで、正誤判定・認証は`/auth`エンドポイント（Worker側）で行う（設計は`design.md` 5章）
- `/chat`は`/auth`が発行したトークン（`HttpOnly; Secure; SameSite=Strict`のCookie、有効期限7日）による認証を必須とし、認証なし・無効トークンでは応答しない（`design.md` 5章）
- PINは4桁数字のまま維持する。ブルートフォース対策はWorkers Rate Limiting bindingによる実用上の抑止に留まり、厳密な総当たり防止ではないことを残余リスクとして受容する（`design.md` 5章・6-2）
- 秘密情報（`GEMINI_API_KEY`・`GITHUB_TOKEN`・PIN検証用シークレット・トークン署名鍵）はコードに直書きせず、Cloudflareのsecrets機能で管理する。ローカル開発では`.dev.vars`（gitignore対象）を使う
- ログにPIN・認証トークン・会話内容・ナレッジ本文・APIキー等の秘密情報を出力しない

### 非機能要件
- Workers単体構成（`design.md` ADR参照）を採用するため、静的配信とAPIが同一オリジンとなりCORS設定自体が不要になる
- ダウンタイムは許容する（個人・家族利用のアプリのため、切り替え時に数分〜数十分止まっても問題ない）
- 入力上限（文字数・件数・ボディサイズ）・エンドポイントごとのレート制限・ナレッジ取得失敗時のfail-closed・タイムアウト・必須シークレット欠如時の503を設ける（詳細は`design.md` 6章）。個人・家族利用規模を踏まえ、過剰な監視基盤は導入しない

## 6. 制約・前提

- 個人開発・非エンジニアのユーザーが将来的にも保守できるよう、構成をシンプルに保つ
- Cloudflareアカウントは今回新規に用意する前提（既存アカウントの有無は未確認）
- 移行に伴うデータ移行は発生しない（ナレッジはGitHub側で変更なし）

## 7. 決定済み事項（設計フェーズで確定）

- カスタムドメインは使わず、Cloudflare標準ドメイン（`*.workers.dev`）で進める
- フロント・バックエンドは分離せず、Workers単体（Static Assets）に統合する（`design.md` ADR）
- 旧Cloud Run・GitHub Pagesは切り替え後2週間並行保持してから停止・削除する（`design.md` 8章）
- Workers内でのGemini API呼び出しはREST API直接呼び出し（SDK不使用）とする
- 4桁PINの総当たり対策はDurable Objectを導入せず、Workers Rate Limiting binding（60秒窓）による抑止に留める。厳密な防止ではないことは残余リスクとして受容する

## 8. 完了の定義

- Cloudflare Workersでフロントエンド（静的ファイル）・`/chat`・`/health`が既存と同等に稼働する
- `/chat`にサーバー側認証（PIN照合）が実装され、認証なしでは応答しない
- PINの扱い（現行値`1122`を維持する、ユーザーの最終決定）が`WORKER_PIN`シークレットに反映されている
- 入力上限・レート制限・fail-closed・タイムアウトが実装されている（`design.md` 6章）
- 秘密情報がすべてCloudflare secretsに移行され、コード・リポジトリに含まれていない
- API契約（`design.md` 4章）に対する自動テストが用意され、CI/CDでデプロイ前に実行される
- `fukuchan-knowledge/docs/README.md`・`docs/SPEC.md`・`docs/SETUP_MANUAL.md`、および`fukuchan-app`のPublic README のアーキテクチャ記述が新構成に更新されている
- LINEのリンクが新URLに更新され、旧GitHub PagesのURLが新URLへの転送ページになっている
- ツールチェーン（wrangler・Node.js）のバージョンが固定されている
