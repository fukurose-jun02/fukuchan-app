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

状態: 一部合格。外部API資格情報の更新待ちで正常系`/chat`は未完了。

- [x] `/health` 200
- [x] `/auth` 正しいPINで200・Cookie発行、誤ったPINで401
- [x] `/chat` Cookieなしで401
- [x] 長文で413、不正roleで413
- [x] `/`と`/images/fuku-icon.png`が200
- [x] 無効なGitHub資格情報を502でfail-closed
- [ ] 新しいGitHub fine-grained PAT（対象repo限定、Contents read-only）へ更新
- [ ] 新しいGemini Auth keyへ更新
- [ ] 有効な資格情報で`/chat`正常系が200となることを確認
