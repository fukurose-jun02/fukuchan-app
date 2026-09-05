# 設計書：Cloudflareへのインフラ移行

対応する要件定義: [requirements.md](requirements.md)
レビュー記録: [tasks/todo.md](../tasks/todo.md)（初回レビュー・再レビュー双方の指摘を本改訂で反映）

## 0. ADR：フロント・バックエンドの構成

### 検討した選択肢

| 案 | 内容 |
|---|---|
| A. Pages + Worker分離 | 静的サイトをCloudflare Pages、APIをCloudflare Workersの別製品で運用 |
| B. Workers単体（Static Assets） | 1つのWorkerが静的ファイル配信と`/chat`等のAPIを両方担う |

### 決定：B（Workers単体）を採用

- アプリの規模が単一HTMLファイル＋APIエンドポイント1つと小さく、2製品に分ける必然性がない
- 静的配信とAPIが同一オリジンになるため、**CORS設定が丸ごと不要になる**（現行設計にあったCORSまわりの複雑さが消える）
- デプロイ対象・秘密情報の設定先が1つに集約され、運用時に迷う箇所が減る
- Cloudflareも小〜中規模のフルスタックアプリに対してこの構成を現在推奨している

以降の設計はすべてこの前提で記述する。

## 1. システム構成（移行後）

```
LINE
↓（リンクタップ、移行完了後にURLを更新）
Cloudflare Workers（fukuchan-app：静的ファイル配信 + /chat, /health API）
↓
GitHub Private Repo（fukuchan-knowledge）+ Gemini API
```

Worker1つの中に、静的アセット（`index.html`等）と`fetch`ハンドラ（API処理）が同居する。

## 2. コンポーネント対応表

| 役割 | 移行前 | 移行後 |
|---|---|---|
| フロント・バックエンドのホスティング | GitHub Pages（フロント）／Google Cloud Run（バックエンド）に分離 | Cloudflare Workers 1つに統合 |
| デプロイ契機 | フロント：`.github/workflows/pages.yml`／バックエンド：手動`gcloud run deploy`等 | `wrangler deploy`（CI/CD化は6章参照） |
| バックエンド実装言語 | Python（FastAPI） | JavaScript（Workers標準ランタイム、フレームワーク不使用） |
| 秘密情報管理 | Cloud Runの環境変数 | 本番：`wrangler deploy --secrets-file .dev.vars`（Workers Secrets、6-5章）／ローカル：`.dev.vars`（後述） |
| ソース管理場所 | フロント：`fukuchan-app/index.html`／バックエンド：`fukuchan-knowledge/backend/`（Python） | 統合Workerプロジェクト：`fukuchan-app/`直下（後述の構成） |

移行中は旧構成（Python版`backend/`・GitHub Pages）を並行稼働させ、切り替え確認後に削除する（8章）。

## 3. リポジトリ・フォルダ構成の変更

Workers単体構成にするため、静的ファイル（`index.html`等）とAPIコードを同じWorkerプロジェクトに置く必要がある。フロントエンドは元々`fukuchan-app`リポジトリにあるため、**Workerプロジェクトも`fukuchan-app`リポジトリ側に新設**する（`fukuchan-knowledge`側にあった`backend/`は移行完了後に削除）。

### ブランチ戦略（重要）

`fukuchan-app`のmainブランチは**現在も本番のGitHub Pagesとして稼働中**。移行作業をmainに直接コミットすると、切り替え確認が終わる前にGitHub Pages側の配信内容が壊れてしまう。そのため、

- 移行作業はすべて作業ブランチ（例：`cloudflare-migration`）上で行い、mainへは**カットオーバー時にのみ**マージする
- 作業開始時点のmainのHEADに`pre-cloudflare-migration`タグを打ち、いつでもその時点のGitHub Pages配信内容に戻せるようにする
- ルート直下の`index.html`・`images/`は**移動（`git mv`）ではなくコピー**して`public/`配下に置く。ルート側を転送ページに差し替えるのは**カットオーバー直後（8章）**の1回のみで、2週間の並行稼働期間の開始時点から転送ページになっている（2週間後に差し替えるのではない）

### フォルダ構成

```
fukuchan-app/
├── index.html            ← 既存（GitHub Pages向け、カットオーバーまで変更しない）
├── images/
│   └── fuku-icon.png     ← 既存
├── public/                    ← Workers Static Assetsの配信対象
│   ├── index.html              ← index.htmlのコピー（API呼び出し部分を書き換え）
│   └── images/
│       └── fuku-icon.png       ← images/のコピー
├── src/
│   └── index.js           ← 新規：/auth・/chat・/healthのAPIロジック
├── wrangler.toml           ← 新規：Workers設定
├── .dev.vars               ← 新規：ローカル開発用の秘密情報（.gitignore対象）
└── .github/workflows/
    └── deploy-worker.yml   ← 新規：Workersへのデプロイ用CI/CD（10章）
```

`.gitignore`に`.dev.vars`を追加する。`public/`配下に静的アセットが正しく配信されること（`/images/fuku-icon.png`が200で返る等）は、自動テストでは検証できないため`wrangler dev`での手動確認に含める（4-4）。

### wrangler.tomlのStatic Assets設定

Workers Static Assetsを使うため、`wrangler.toml`に最低限以下を明記する（[公式ドキュメント](https://developers.cloudflare.com/workers/static-assets/binding/)、正確なキー名は実装時に確認）。

- `directory`：静的ファイルの配信元（`./public`）
- `binding`：Workerコードから静的アセットを参照する際のバインディング名
- `run_worker_first`：`/auth`・`/chat`・`/health`のような動的ルートを静的アセットの探索より先にWorkerのfetchハンドラへ渡すための設定。これが無いと、パスによっては静的ファイル探索が優先され、APIルートに届かない場合がある

### 環境変数・シークレット一覧

| 名前 | 種別 | 設定場所 | 用途 |
|---|---|---|---|
| `GEMINI_API_KEY` | シークレット | 本番：`wrangler deploy --secrets-file .dev.vars`／ローカル：`.dev.vars` | Gemini API呼び出し（`x-goog-api-key`ヘッダー） |
| `GITHUB_TOKEN` | シークレット | 同上 | GitHub Contents API呼び出し |
| `WORKER_PIN` | シークレット | 同上 | `/auth`でのPIN照合 |
| `AUTH_TOKEN_SECRET` | シークレット | 同上 | 認証トークンのHMAC署名鍵（5章） |
| `GITHUB_REPO` | 通常変数 | `wrangler.toml`の`[vars]` | ナレッジ取得先リポジトリ名（秘密情報ではないため平文でよい） |

## 4. API契約（正規仕様として確定）

既存フロントエンドのコード（`index.html`の送信処理）を実際に読み、以下を契約として確定する。齟齬が生じないよう、実装後にこの契約に対する自動テストを用意する（4-4）。

### 4-1. 日付の扱い（訂正）

移行前の設計書には「バックエンドが当日日付をシステムプロンプトに注入する」と誤って記載していたが、実際は**フロントエンドが`history`配列の先頭に日付を伝える2ターン（user/model）を毎回追加してから送信している**。バックエンドは日付処理を一切行わず、渡された`history`をそのままGeminiに渡すだけ。この役割分担は移行後も変えない（バックエンド側で日付ロジックを新設しない）。

### 4-2. POST /chat

**リクエスト**
```json
{
  "message": "妻の誕生日はいつ？",
  "history": [
    { "role": "user", "content": "今日の日付は2026年9月5日 土曜日です。" },
    { "role": "model", "content": "わかったよ！今日の日付を考慮して答えるね。" },
    { "role": "user", "content": "（それ以前の会話、最大40ターン）" },
    { "role": "model", "content": "..." }
  ]
}
```
- `role`は`"user"`／`"model"`の2種類のみ（Gemini REST APIの`contents[].role`とそのまま一致する。OpenAI系の`"assistant"`ではないことに注意）
- `history`はクライアント側で直近40ターンに切り詰め済み

**認証（5章で`/auth`が発行したCookieを使う）**
```
Cookie: fuku_session=<トークン>
```
ブラウザが自動的に付与するため、フロントエンドのJavaScriptで明示的に付ける必要はない。

**レスポンス（成功）**
```json
{ "reply": "（架空例）Aさんの誕生日は3月8日だよ🎂" }
```

**レスポンス（エラー）**
| ステータス | 条件 |
|---|---|
| 401 | 認証Cookieが無い／トークンが無効・期限切れ（5章） |
| 413 | `message`／`history`が上限（文字数・件数・ボディサイズ）超過（6-1） |
| 429 | レート制限超過（6-2） |
| 502 | ナレッジ取得（GitHub API）失敗、またはGemini APIの応答異常（タイムアウト以外、fail-closed、6-3） |
| 503 | 必須シークレット未設定（6-5） |
| 504 | GitHub APIまたはGemini APIの呼び出しがタイムアウト（6-3, 6-4） |

### 4-3. Worker内部でのGemini呼び出し（REST API）

`google-generativeai`のPython SDKが内部で呼んでいるのと同じエンドポイントを直接`fetch`する。APIキーはURLのクエリパラメータ（`?key=`）ではなく、Googleが推奨する`x-goog-api-key`ヘッダーで送る（クエリパラメータはアクセスログ等に残りやすいため）。

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
x-goog-api-key: ${GEMINI_API_KEY}
Content-Type: application/json
```

```json
{
  "system_instruction": { "parts": [{ "text": "<プロンプト+ナレッジ>" }] },
  "contents": [
    { "role": "user", "parts": [{ "text": "今日の日付は..." }] },
    { "role": "model", "parts": [{ "text": "わかったよ！..." }] },
    { "role": "user", "parts": [{ "text": "妻の誕生日はいつ？" }] }
  ]
}
```

SDKの`start_chat(history).send_message(message)`は「`history` + 今回の`message`をまとめて1回の`generateContent`に渡す」のと等価なため、`history`配列の末尾に`{role:"user", parts:[{text: message}]}`を追加してから送信する。

レスポンスから`candidates[0].content.parts[0].text`を取り出して`reply`とする。候補が0件の場合は502として扱う。

### 4-4. 契約テスト（実装確認済み）

`src/index.js`に対する自動テストを`@cloudflare/vitest-plugin`（[公式ドキュメント](https://developers.cloudflare.com/workers/testing/vitest-integration/)）で実装し、`npx vitest run`で23件すべて成功することを確認済み。

**自動テストで固定している範囲**
- `validateChatBody`：`role`が`"user"`/`"model"`以外・`message`/`history`の長さ上限超過を弾くこと（純粋関数の単体テスト）
- `createToken`/`verifyToken`：発行直後は有効、期限切れ・署名改ざん・別鍵署名は無効と判定されること
- `timingSafeStringEqual`の等価判定
- `statusForUpstreamError`：`TimeoutError`は504、それ以外（GitHub/Geminiの4xx・5xx・candidates 0件）は502にマッピングされること（6-3の表と一致）
- `/health`のレスポンス形状
- `/auth`：正しいPINでCookie（`HttpOnly`・`SameSite=Strict`）が発行されること、誤ったPINで401になること、ボディが大きすぎる場合に413になること（`Content-Length`を付けない状態でも実バイト数で判定されること）
- `/chat`：認証Cookie欠如・無効Cookieで401、`message`上限超過で413になること

**自動テストの対象外（`wrangler dev`での手動確認に委ねる、実装計画フェーズ3）**
- `@cloudflare/vitest-plugin`（2026年9月時点のv1.1.4）はGitHub/Gemini等への外部fetchをインターセプトする仕組み（`fetchMock`等）を提供していないため、実際のGitHub Contents API・Gemini API呼び出しを含む`/chat`の正常系・fail-closed系は自動テスト化できなかった
- レート制限（429）・必須シークレット欠如（503）・静的アセット配信も、テスト環境でのバインディング上書きや`run_worker_first`スコープの都合上、自動テストには含めていない
- これらは実装計画のフェーズ3で`wrangler dev`を使い、GitHubトークンを意図的に無効化する等の方法で手動確認する

## 5. 認証設計（再改訂）

現行実装（`index.html:563`）は`const CORRECT_PIN = '<現行PIN>';`のように**正解のPINそのものが公開JSに埋め込まれており**、閲覧者はページのソースを見るだけでPINが分かってしまう。前回改訂案（PINをそのまま`Authorization`ヘッダーに載せて毎回照合する）は、サーバー側チェックを追加した点は前進だが、フロントエンドに正解PINを持たせる構造自体は変えておらず、`CORRECT_PIN`を消せていなかった。今回はこれを解消する。

**PIN値の決定（残余リスクとして受容）**：現行PINは既にPublicリポジトリのコミット履歴で公開済みであり、AIからは新しい値へのローテーションを推奨した。しかしユーザーは「家族で覚えやすい値を優先したい」という理由で、**現行PIN（`1122`）をそのまま`WORKER_PIN`に設定する方針を最終決定**した。この結果、`/auth`によるサーバー側認証を導入しても、PINの値そのものは既に公開されているため、知っている第三者に対する実質的な保護効果は無い。この残余リスクを受容した上で、認証の仕組み自体（Cookie発行・fail-closed・レート制限等）は他のセキュリティ対策として引き続き有効に機能する。

### 方式：`/auth`によるトークン発行（Cookieベースに変更）

- **フロントエンドは正解のPINを一切持たない**。ユーザーが入力したPINは`/auth`エンドポイントに送るだけで、正誤判定は完全にWorker側（`WORKER_PIN`シークレットとの照合）で行う
- 照合に成功したら、Workerは有効期限つきの署名付きトークンを発行する
  - トークン形式：`${有効期限のUNIXタイムスタンプ}.${HMAC-SHA256署名のbase64url}`
  - 署名鍵は`WORKER_PIN`とは別の専用シークレット`AUTH_TOKEN_SECRET`（十分な長さのランダム文字列）を使う。4桁PINを鍵にすると、発行済みトークン1つから総当たりで鍵＝PINを割り出せてしまうため
- **トークンは`localStorage`ではなく`HttpOnly; Secure; SameSite=Strict`のCookieとして`/auth`のレスポンスヘッダー（`Set-Cookie`）で渡す。** ADR（0章）でフロント・バックエンドを同一オリジンに統合したことで、Cookieベースの認証がCORSの複雑さなしに使えるようになった。HttpOnlyにすることで、フロントのJavaScriptからトークンの値を読み出せなくなり、XSS等でトークンが窃取されるリスクを構造的に無くせる（`localStorage`保存だとJSから読めてしまい、XSS一発で30日間有効なトークンが漏れる）
  - 有効期限は7日とする（30日は必要以上に長く、漏洩時の影響期間が大きいため短縮。家族利用なので7日ごとの再入力は許容範囲と判断）
  - `SameSite=Strict`により、他サイトからのリクエストにCookieが付与されないためCSRF対策も兼ねる
- `/chat`はこのCookieを必須とし、Worker側で署名と有効期限を検証する（KVや外部ストレージを使わない、自己完結型の検証なのでステートレス設計を維持できる）
- Cookieが無効・期限切れの場合は401を返し、フロントエンドはPIN入力画面に戻す

### エンドポイント追加：POST /auth

**リクエスト**
```json
{ "pin": "<入力されたPIN>" }
```

**レスポンス（成功）**
```
Set-Cookie: fuku_session=1780000000.xxxxxxxxxxxxxxxxxxxxxxxx; HttpOnly; Secure; SameSite=Strict; Max-Age=604800; Path=/
```
```json
{ "ok": true }
```

**レスポンス（失敗）**：401

### ブルートフォース対策（決定・残余リスクの明記）

PINは4桁（10,000通り）のまま維持する（Durable Objectのような厳密なロックアウトは導入せず、家族が覚えやすい4桁数字というUXを優先する）。防御は6-2のWorkers Rate Limiting binding（60秒窓）による`/auth`への制限のみとし、以下を**残余リスクとして受容する**。

- Workers Rate Limitingのカウンタは拠点（データセンター）ごとに分散しており、globally strictな制限ではない（[Cloudflare公式](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)）。攻撃者が複数拠点経由でリクエストを送れば、名目上の制限より多くの試行が通る可能性がある
- そのため本設計は「総当たりを完全に防ぐ」ものではなく、「無制限の高速総当たりを防ぐ、実用上の抑止力」として位置づける
- 現行フロントの「3回失敗で30秒ロック」はクライアント側だけの見た目上のUXとして残してよいが、実効的な防御にはならない

## 6. 運用・耐障害性（再改訂）

現行実装にはこれらの考慮がなく、移行を機に最低限を組み込む。個人・家族利用規模のアプリであることを踏まえ、過剰実装は避ける。

### 6-1. 入力上限

- `message`は2,000文字を上限とし、超過時は413を返す（Gemini側のトークン上限保護と、誤操作・攻撃的な長文入力を弾く目的）
- `history`配列は最大40件（フロントの既存の切り詰め仕様に合わせる）までとし、超過分は受け付けず413を返す
- `history`各要素の`content`も2,000文字を上限とする
- リクエストボディ全体のサイズにも上限（目安：50KB）を設ける。**`Content-Length`ヘッダーだけに依存しない**：このヘッダーは欠落（chunked transfer等）や偽装が可能なため、実際にはリクエストボディをストリームとして読みながらUTF-8バイト数を積算し、上限を超えた時点で読み込みを打ち切って413を返す。契約テストに「`Content-Length`が無いケース」「`Content-Length`が実サイズと異なるケース」を含める

### 6-2. レート制限（4桁PIN維持・残余リスク受容の方針で確定）

Cloudflareの「Rate Limiting Rules」（ダッシュボードのWAF機能）は**独自ドメインをCloudflareのゾーンとして管理している場合のみ使える**機能であり、本設計が採用する`*.workers.dev`（ゾーンを持たない、要件定義7章）には適用できない。

代わりに**Workers Rate Limiting（Workerコードから使えるレート制限バインディング）**を`wrangler.toml`に設定し、コード内でIPアドレス（`CF-Connecting-IP`ヘッダー）をキーに制限する。このバインディングは**固定窓が10秒または60秒のみで、カウンタは拠点（データセンター）ごとに分散したeventually consistentな値**という制約がある（[Cloudflare公式](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)）。「15分に5回」のような窓は設定できない。

5章の決定に基づき、4桁PINは維持し、この制約を残余リスクとして受容した上で以下を設定する。バインディングの正確な設定構文（`wrangler.toml`の記法）は実装時にCloudflare公式ドキュメントで確認する。

| エンドポイント | 制限の目安 | 備考 |
|---|---|---|
| `POST /auth` | 60秒窓・5回・IP単位（確定値） | 拠点分散により名目値より緩くなり得るが、無制限の高速総当たりは防げる（5章の残余リスク参照） |
| `POST /chat` | 60秒窓・20回・IP単位（確定値） | 認証済み利用者の通常利用を妨げない範囲で、Gemini API濫用コストを抑える |

制限超過時は429を返す。

### 6-3. ナレッジ取得のfail-closed
- 現行のPython実装は、GitHubからのファイル取得に失敗しても`「（xxxの読み込みに失敗しました）」`という文字列を埋め込んでGeminiに渡し、処理を継続する（fail-open）。これは「情報が無いのに、あるかのように応答が返る」リスクがあるため、**移行後は4ファイルのいずれか1つでも取得に失敗した時点で502を返し、処理を中断する**（fail-closed）
- GitHub・Geminiそれぞれの上流エラーを、以下のようにクライアント向けのステータスへ一貫してマッピングする（契約テストで固定する）

| 上流の状態 | クライアントへの応答 |
|---|---|
| GitHub Contents API：4xx/5xx（タイムアウト以外） | 502 |
| GitHub Contents API：タイムアウト | 504 |
| Gemini API：4xx（不正リクエスト等） | 502 |
| Gemini API：5xx | 502 |
| Gemini API：タイムアウト | 504 |
| Gemini APIレスポンスに`candidates`が0件 | 502 |

「タイムアウトかどうか」で502/504を統一的に分岐する（応答はあったが内容が不正＝502、応答自体が返ってこない＝504）。

### 6-4. タイムアウト
- GitHub Contents APIへの各fetch、Gemini APIへのfetchともに`AbortController`で10秒のタイムアウトを設定し、超過時は504を返す

### 6-5. 必須シークレットの検証・投入方法（改訂）

- Worker起動時（各リクエストの先頭）に`GEMINI_API_KEY`・`GITHUB_TOKEN`・`WORKER_PIN`・`AUTH_TOKEN_SECRET`が全て設定されているか確認し、1つでも欠けていれば503を返す（fail-closed）。設定漏れのまま本番デプロイされて曖昧なエラーになる事態を防ぐ
- **初回の本番投入は、`wrangler secret put`を4回個別に呼ばない。** `secret put`は1回ごとに即時デプロイを伴うため、4回に分けると「一部のシークレットだけ設定された中間状態」のバージョンが順番に公開されてしまう（6-5の503チェックで致命的な誤動作は防げるが、意図しない中間デプロイが複数回発生すること自体を避けたい）。代わりに`wrangler deploy --secrets-file .dev.vars`を使う。`--secrets-file`は`.env`形式のファイルを受け取り、コードとシークレット（最大100件まで）を1回の操作でまとめて投入・デプロイできる（[Cloudflare公式](https://developers.cloudflare.com/workers/configuration/secrets/)）。`.dev.vars`自体が`.env`形式のため、そのまま指定できる。これ以降、別途`wrangler deploy`を単独実行する必要はない
- `wrangler.toml`側で必須シークレット名を宣言できる機能があれば使い、デプロイ前の検証を強化する

### 6-6. ログ・監視（改訂）

- Cloudflare Workers Logsは`wrangler.toml`の`[observability] enabled = true`で設定する（新規作成したWorkerでは既定で有効。設定自体は明示しておく）
- **保持期間はFreeプラン3日・Paidプラン7日**（[Cloudflare公式](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)）。8章の2週間の並行稼働・検証期間より短いため、**期間が過ぎてから確認するのではなく、2〜3日おきに定期確認する**運用にする（14日目にまとめて見ようとしても、序盤のログはすでに消えている）
- **ログにPIN・認証Cookie/トークンの値・ユーザーの会話内容（`message`/`history`）・ナレッジ本文・上流API（Gemini/GitHub）の秘密情報を出力しない。** エラーログにはステータスコードと種別のみを残す
- 個人利用規模のため、外部監視SaaSの導入は行わない。エラー発生時（401多発・429・502・504）はWorkers LogsのFilter機能で事後確認できれば十分とし、常時アラートの仕組みは今回のスコープに含めない（将来必要になれば別途検討）

## 7. 切り戻し方針（ロールバック、改訂）

フロント・バックエンドがWorkers1つに統合されたため、「バックエンドだけ」「フロントだけ」という切り分けができない。そのため以下の独立した切り戻し経路を用意する。

- **Worker全体の切り戻し**：`wrangler rollback`（Cloudflareが直前のデプロイへのワンコマンドロールバックを提供）で即座に旧バージョンへ戻せる
- **GitHub Pagesへの切り戻し**：3章の`pre-cloudflare-migration`タグの内容をmainに戻す（`git revert`または該当タグへの巻き戻し）ことで、移行前のGitHub Pages配信内容を復元できる。移行完了後も一定期間（8章）GitHub Pages側の設定・`.github/workflows/pages.yml`は残しておく
- **LINEのリンク更新**：LINEに登録しているリンクは現在GitHub PagesのURL（`https://fukurose-jun02.github.io/fukuchan-app`）を指している想定。切り替え時に以下を行う
  1. Cloudflare Workers側のURL（`*.workers.dev`）で動作確認が完了してから、LINEのリンクを新URLに更新する
  2. 旧GitHub PagesのURLは削除せず残し、`index.html`をシンプルな自動転送ページ（`<meta http-equiv="refresh">`または`location.replace`）に差し替えて、新URLへ誘導する。ブックマーク・キャッシュされた旧リンクからのアクセスに対応するため

## 8. 旧環境の保持期間

転送ページへの切り替えタイミングは**カットオーバー直後（実装計画のフェーズ5）の1回のみ**とし、それ以外のタイミング（例：2週間後）では行わない。

- カットオーバー直後：LINEリンク更新と同時に、GitHub Pagesの`index.html`を転送ページに差し替える（7章）。Cloud Runもこの時点ではまだ稼働させたままにする
- Cloud Run・GitHub Pages（転送ページ化した状態）は、Cloudflare側切り替え後**2週間**保持してから削除する
- 2週間の間に問題が見つからなければ、`fukuchan-knowledge/backend/`（Python版）・Cloud Runサービス・`.github/workflows/pages.yml`を削除する

## 9. ツールチェーン固定

- `wrangler`のバージョンを`fukuchan-app/package.json`の`devDependencies`にピン留めする（`^`を使わず固定バージョン）
- Node.jsのバージョンを`.nvmrc`で固定し、CI/CD（10章）でも同じバージョンを使う

## 10. CI/CD（新設）

- `.github/workflows/deploy-worker.yml`を新設し、mainブランチへのpush時に`wrangler deploy`を実行する
- デプロイに必要な`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`はGitHub Actionsのrepository secretsに登録する（ユーザーがGitHub側で設定、11章）
- 4-4の契約テストをデプロイ前のステップとして実行し、失敗時はデプロイしない

## 11. ドキュメント更新（完了条件に追加）

移行完了後、以下を更新・整備する。

- `fukuchan-knowledge/docs/README.md`・`docs/SPEC.md`：アーキテクチャ図・API仕様・認証仕様
- `fukuchan-app`のPublicな`README.md`：構成説明をWorkers単体構成に更新
- `fukuchan-knowledge/docs/SETUP_MANUAL.md`：Cloudflareアカウント作成・`wrangler login`・secrets登録・CI/CD用トークン設定の手順を追加
