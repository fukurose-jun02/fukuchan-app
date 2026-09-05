# 実装計画書：Cloudflareへのインフラ移行

対応する設計: [design.md](design.md)（Workers単体構成／初回・再レビュー反映版）

## 役割分担の考え方

Cloudflareアカウント作成・ログイン認証（OAuth）・実際のAPIキー/PIN値の入力は、セキュリティ上AIが代行できない操作のため**ユーザー自身**が行う。コードの実装・ファイル操作・コマンドの提案は**AI（Claude Code）**が担当する。デプロイ・インフラ変更コマンドの実行は、その都度ユーザーに確認してから進める。

| フェーズ | AIが担当 | ユーザーが担当 |
|---|---|---|
| 準備 | 作業ブランチ・タグ作成、`wrangler.toml`・フォルダ構成の作成、ツールチェーン固定 | Cloudflareアカウント作成、`wrangler login`（ブラウザ認証） |
| 実装 | `src/index.js`実装（`/auth`・`/chat`・`/health`・静的配信・運用制限）、契約テスト作成 | 実際のシークレット値の入力（`wrangler secret put`／`.dev.vars`） |
| 動作確認 | 確認手順の提示、レスポンスの確認・デバッグ | ローカルでのコマンド実行の承認 |
| デプロイ・CI/CD | デプロイコマンド・GitHub Actions設定の提案 | 実行の承認、GitHub Actions secretsの登録（ダッシュボード操作） |
| 切り替え | LINEリンク更新手順の提示、mainへのマージ・転送ページの実装 | Cloudflareダッシュボードでの最終確認、LINEリンクの実際の変更 |
| 旧環境停止 | 不要ファイルの削除、ドキュメント更新 | Cloud Runサービスの削除（GCP課金に関わるため） |

## フェーズ0：ブランチ準備（新設）

現行mainブランチはGitHub Pagesとして稼働中のため、移行作業で壊さないようにする（`design.md` 3章）。

- [x] （AI）現在のmain HEADに`pre-cloudflare-migration`タグを作成する
- [x] （AI）作業ブランチ`cloudflare-migration`を作成し、以降の作業はすべてこのブランチ上で行う

## フェーズ1：準備

- [ ] （ユーザー）Cloudflareアカウントを作成する（既にあれば不要）
- [ ] （ユーザー）ローカルに`wrangler`をインストールし、`wrangler login`でブラウザ認証する
- [x] （AI）`fukuchan-app/`直下に`public/`・`src/`フォルダ、`wrangler.toml`の雛形を作成する
- [x] （AI）`package.json`に`wrangler`をバージョン固定で追加し、`.nvmrc`でNode.jsバージョンを固定する
- [x] （AI）`.gitignore`に`.dev.vars`を追加する
- [ ] （ユーザー）`.dev.vars`に`GEMINI_API_KEY`・`GITHUB_TOKEN`・`WORKER_PIN`・`AUTH_TOKEN_SECRET`のローカル用の値を記入する（`.dev.vars.example`を参考に。`WORKER_PIN`は現行PINを再利用せず新しい4桁へローテーションする。`AUTH_TOKEN_SECRET`はPINとは別のランダムな文字列を新規に用意する）
- [ ] （ユーザー）Gemini APIキーが現行有効な「APIキー」であることを事前に確認する（Google AI Studio等で発行したキーの種別・有効性をデプロイ前にチェック）

## フェーズ2：実装

- [x] （AI）`index.html`・`images/`を**コピー**して`public/`配下に配置する（`git mv`はしない。ルート側は変更しない、`design.md` 3章）
- [x] （AI）`public/index.html`から`API_URL`関連のロジックを削除し、同一オリジンで`/auth`・`/chat`を呼ぶよう修正する
- [x] （AI）`public/index.html`から`CORRECT_PIN`の直書きを削除し、入力されたPINを`/auth`に送るロジックに変更する。認証状態はCookie（ブラウザが自動送信）で管理するため、フロントエンドでトークン値を保持・付与するコードは書かない（`design.md` 5章）。あわせて`/chat`が401を返した場合にPIN画面へ戻す処理も追加
- [x] （AI）`wrangler.toml`にStatic Assets設定（`directory`・`binding`・`run_worker_first`）を明記する（`design.md` 3章。公式ドキュメントで構文確認済み）
- [x] （AI）`src/index.js`を実装する
  - 静的アセット配信（`public/`）と`/auth`・`/chat`・`/health`のルーティング
  - `/auth`：PIN照合、成功時にHMAC署名付きトークンを`Set-Cookie`（`HttpOnly; Secure; SameSite=Strict; Max-Age=604800`）で発行（`design.md` 5章）
  - `/chat`：Cookieの署名・有効期限検証、失敗時401
  - 必須シークレット（`GEMINI_API_KEY`・`GITHUB_TOKEN`・`WORKER_PIN`・`AUTH_TOKEN_SECRET`）の存在チェック、欠如時503（`design.md` 6-5）
  - GitHub Contents APIから4ファイルを取得する処理（失敗時502／タイムアウト時504のfail-closed、`design.md` 6-3）
  - Gemini REST API（`generateContent`）呼び出し（`x-goog-api-key`ヘッダー使用）と会話履歴の変換（`design.md` 4-3）
  - 入力上限チェック：`message`長・`history`件数と各要素長は事前チェック、**ボディサイズはストリームを読みながら実バイト数を積算**して413を返す（`Content-Length`ヘッダーの値は信用しない、`design.md` 6-1）・タイムアウト（504、`design.md` 6-4）
  - 上流エラーのステータスマッピング（`statusForUpstreamError`関数として切り出し。`design.md` 6-3の表通り、タイムアウトは504・それ以外の異常は502で統一）
  - ログにPIN・Cookie/トークン・会話内容・ナレッジ・秘密情報を出力しない（`design.md` 6-6）
- [x] （AI）契約テストを作成し、23件すべて成功することを確認済み（`design.md` 4-4、`@cloudflare/vitest-plugin`使用）。413（文字数超過・`Content-Length`欠落ケース）・401（Cookie欠如・無効）・トークン検証・上流エラーの502/504マッピングを自動テスト化。429・503・静的アセット配信は外部fetchモック機構が無いため自動テスト化できず、フェーズ3の手動確認に委ねる（`design.md` 4-4参照）
- [x] （AI）`wrangler.toml`にWorkers Rate Limitingバインディングを設定した（`design.md` 6-2。公式ドキュメントで構文確認済み）
  - `/auth`：60秒窓・10回
  - `/chat`：60秒窓・20回

## フェーズ3：動作確認（ローカル）

- [ ] （AI・ユーザー）`wrangler dev`でローカル起動し、以下を確認する
  - `/health`の疎通
  - `/auth`：正しいPINでCookie発行、誤ったPINで401
  - `/chat`：正しいCookieで成功、Cookie無し・無効Cookieで401
  - 上限超過（長文・history件数超過、`Content-Length`欠落／偽装ケース含む）での413
  - GitHubトークンを意図的に無効化した状態での502（fail-closed確認）、GitHub APIを意図的にタイムアウトさせた場合の504
  - 必須シークレットを1つ欠いた状態での503
  - 静的アセット（`/`・`/images/fuku-icon.png`）が正しく配信されること
- [ ] （AI）契約テストを実行し、全て通ることを確認する

## フェーズ4：デプロイ・CI/CD

- [ ] （ユーザー）GitHub Actions用に`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`をリポジトリsecretsに登録する
- [ ] （AI）`.github/workflows/deploy-worker.yml`を作成する（契約テスト→`wrangler deploy`の順で実行、`cloudflare-migration`ブランチではデプロイせずテストのみ、mainへのマージ時にデプロイする設定にする）
- [ ] （ユーザー承認の上でAIが実行）本番シークレットを登録する。`wrangler secret put`を4回individualに呼ぶ運用はせず、コードとシークレットを1つのバージョンとしてまとめて投入する方法（`--secrets-file`等）を使う。正確な手順は実装時に[公式ドキュメント](https://developers.cloudflare.com/workers/configuration/secrets/)で確認する（`design.md` 6-5）
- [ ] （AI）`wrangler deploy`で一度手動デプロイし、Workers URL（`*.workers.dev`）で`/health`・`/auth`・`/chat`一式を確認する（この時点ではまだmainにマージしない＝GitHub Pagesはそのまま）

## フェーズ5：切り替え

- [ ] （AI・ユーザー）Workers URLで、PIN入力→認証Cookie取得→チャット送信→ナレッジを踏まえた応答までの一連の流れを確認する
- [ ] （AI・ユーザー承認）`cloudflare-migration`ブランチをmainにマージする（CI/CDが動きWorkersに本番デプロイされる）
- [ ] （ユーザー）LINEに登録しているリンクを新しいWorkers URLに更新する
- [ ] （AI）ルート直下の`index.html`を、新URLへの転送ページに差し替える（`design.md` 7章）。この時点でGitHub Pagesは転送専用になる

## フェーズ6：並行稼働・検証期間（2週間）

- [ ] （AI・ユーザー）2〜3日おきにWorkers Logsを確認する（保持期間がFree 3日/Paid 7日のため、14日目にまとめて見ても序盤のログは残っていない、`design.md` 6-6）
- [ ] （AI・ユーザー）2週間、Cloudflare側での稼働に問題がないか確認する（Cloud Run・GitHub Pages転送は維持し、問題があれば`pre-cloudflare-migration`タグへ戻せる状態を保つ）
- [ ] （AI）`fukuchan-knowledge/docs/README.md`・`docs/SPEC.md`・`docs/SETUP_MANUAL.md`、`fukuchan-app`のPublic README を新構成に更新する

## フェーズ7：旧環境の停止・後片付け

- [ ] （ユーザー）Google Cloud ConsoleでCloud Runサービスを削除する
- [ ] （AI）`fukuchan-knowledge/backend/`（Python版）を削除する
- [ ] （AI）`.github/workflows/pages.yml`を削除する
- [ ] （AI）作業ログ・判断データログに移行完了を記録する

## 完了確認チェックリスト

- [ ] Cloudflare Workersでフロントエンド（静的ファイル）が表示され、PIN入力→認証Cookie取得の流れが動作する
- [ ] フロントエンドのコードに正解PINが含まれていない
- [ ] `WORKER_PIN`が現行の公開済みPINから新しい値にローテーションされている
- [ ] `/chat`がCookie認証を要求し、認証なし・無効Cookieでは401を返す
- [ ] `/chat`が既存と同等の応答を返す（ナレッジ・日付ターンの扱いを含む）
- [ ] 入力上限（実バイト数ベース）・エンドポイント別レート制限・fail-closed・タイムアウト・必須シークレット欠如時の503が機能する
- [ ] 契約テスト（自動化できる範囲）がCI/CDでデプロイ前に実行され、通っている。429・503・静的アセット配信はフェーズ3の手動確認で担保されている
- [ ] 秘密情報・PIN・認証トークンがコード・リポジトリ・ログに含まれていない
- [ ] 本番シークレットがコード（バージョン）とまとめて1回で投入されている（4回の個別`secret put`になっていない）
- [ ] LINEのリンクが新URLになっている、旧URLは転送ページになっている
- [ ] 問題発生時に`pre-cloudflare-migration`タグ・`wrangler rollback`のいずれでも切り戻せることを確認済み
- [ ] Cloud Run・旧GitHub Pages設定（2週間後）が停止・削除されている
- [ ] ドキュメント（`fukuchan-knowledge`側3点・`fukuchan-app`側README）が新構成に更新されている
- [ ] ツールチェーン（wrangler・Node.js）のバージョンが固定されている
