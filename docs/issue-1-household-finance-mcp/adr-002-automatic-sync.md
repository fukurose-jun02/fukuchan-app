# ADR-002：手動CSVなしの家計データ自動同期

**Status:** Proposed（認証情報保管と実ログインPoCは承認済み、実運用採用は未確定）
**Date:** 2026-09-12  
**Deciders:** プロジェクト管理者、実装担当AI

## Context

現行の家計MCPは、Cloudflare D1の`active`スナップショットを読み取るだけであり、Money Forward MEからの取得処理はまだ実装していない。従来案は、Mac等の常時起動ホストでcrawlerを実行し、SQLiteからD1へ同期する構成だった。

しかし、Macはスリープするため、手動CSVやMac上の同期ジョブを前提にすると「自動で最新化される」という目的を満たしにくい。ユーザーの希望は、手動CSVなしで、Macがスリープしていても定期的に同期されることである。

この変更候補には、次の制約がある。

- Money Forward MEの個人向け公式APIを前提にできず、Web画面の自動操作に依存する。
- Browser RunのアクセスがBot対策で拒否される可能性がある。
- OTP・追加認証、画面変更、セッション失効が発生し得る。
- CloudflareへID・パスワード・ブラウザ状態を保管する場合、従来の「認証情報はローカルのみ」という要件を変更する。
- 同期失敗時に不完全なデータを公開してはならない。

## Decision

以下を**第一候補としてPoCで検証する**。このADR自体は提案であり、実データ同期を開始する決定ではない。

```text
Cloudflare Cron Trigger（まずは1時間ごと）
  ↓
同期専用Worker（finance-sync）
  ↓
Cloudflare Browser Run / Playwright
  ↓
Money Forward MEの読み取り
  ↓
集計・件数・日次/月次整合性の検証
  ↓ 成功時のみ
D1 stagingへ投入 → activeへ切り替え
  ↓
既存の読み取り専用finance MCPが照会
```

設計上の不変条件は次のとおりとする。

1. `fukuchan-finance-mcp`は読み取り専用のまま維持し、同期処理を持たせない。
2. 同期Workerは別Workerとして分離し、Cron実行とMCP照会の障害影響を分ける。
3. D1は`staging`へ全量を検証してから、成功時だけ`active`を切り替える。失敗時は直前の`active`を維持し、`stale`として返す。
4. Geminiへ送るのは質問に必要な集計結果・鮮度・基準日時だけで、Money Forwardの認証情報や取引明細は送らない。
5. 実データへのログイン・取得は、承認済みの1回限りの実ログインPoCに限定し、実運用同期は別のGo判定が済むまで行わない。

## Options Considered

### Option A：ローカル常時起動ホスト（従来案）

| Dimension | Assessment |
|---|---|
| Complexity | 中 |
| Cost | 低〜中 |
| Availability | Macのスリープ・停止に依存 |
| Security | 認証情報をローカルに限定できる |
| Maintenance | upstream crawlerとホストの保守が必要 |

**Pros:** 既存`mf-dashboard`の前提に近く、認証情報をCloudflareへ置かずに済む。  
**Cons:** Macがスリープすると同期されず、ユーザーの自動同期要件を満たせない。

### Option B：Cloudflare Cron + Browser Run（第一候補）

| Dimension | Assessment |
|---|---|
| Complexity | 高 |
| Cost | Browser Runの利用量に依存 |
| Availability | Macの状態から独立できる |
| Security | Cloudflare Secrets / Secrets Storeへ保管する認証情報が増える |
| Maintenance | Web画面変更、Bot対策、OTP、セッションを継続対応 |

**Pros:** Macがスリープしても定期実行でき、手動CSVをなくせる。Cron、Browser Run、D1を同じ基盤に置ける。  
**Cons:** 非公式Web自動操作の継続性が保証されず、認証情報の保管場所を変更する。費用・利用制限も確認が必要。

### Option C：Money Forward公式API

| Dimension | Assessment |
|---|---|
| Complexity | 低〜中（提供されていれば） |
| Cost | 契約・提供条件に依存 |
| Availability | API仕様と権限に依存 |
| Security | OAuth等の公式認証を利用できる可能性 |
| Maintenance | Web画面変更の影響を受けにくい |

**Pros:** Web自動操作とBot対策のリスクを避けられる。  
**Cons:** 個人向けMoney Forward MEで本件に使える公式APIが確認できていないため、現時点では選択できない。

### Option D：手動CSVインポート

| Dimension | Assessment |
|---|---|
| Complexity | 低 |
| Cost | 低 |
| Availability | ユーザー操作時のみ |
| Security | 認証情報を預けずに済む |
| Maintenance | CSV形式変更への対応が必要 |

**Pros:** 最も実装しやすく、Web自動操作のリスクがない。  
**Cons:** 手動作業が残り、今回の「手動CSVなし」という要件を満たせない。

## PoC Scope

PoCでは、いきなり本番定期同期を有効にしない。次の順で実施する。

1. 実データを使わず、Browser Runの起動・終了、Playwrightのページ取得、Cronの`scheduled()`呼び出しを確認する。
2. Money Forwardログイン画面まで到達できるかを確認する。認証情報は入力しない段階を設ける。
3. ユーザーが明示的に承認した場合だけ、Secretsの保管とログインを1回検証する。OTPが要求された場合は自動化を中断し、手動再認証の運用可否を確認する。
4. 読み取り結果を実データのまま保存せず、件数・列・画面変更検知などの非機密検証を行う。
5. 実データをD1へ投入する前に、staging/active切り替え、整合性検証、失敗時の旧active維持を架空fixtureで検証する。

## Go / No-Go Criteria

### Go

- Browser Runで対象画面へ安定して到達できる。
- ログイン・セッション再利用・失効時の再認証手順が定義できる。
- Bot対策・OTP・費用・利用制限が、個人利用の範囲で受容できる。
- Cloudflare Secrets / Secrets Storeへ認証情報を保存することをユーザーが明示承認する。
- 架空fixtureでstaging検証とactive切り替え、失敗時の旧active維持が確認できる。

### No-Go

- 対象画面へのアクセスがBot対策で継続的に拒否される。
- OTPや追加認証を安全に運用できない。
- 認証情報をCloudflareへ保管することを受容できない。
- Browser Runの費用・制限が個人利用の前提に合わない。

No-Goの場合は、認証情報をローカルに限定するOption Aまたは、手動CSVのOption Dへ戻す。既存のMCP照会とデモD1は維持する。

## Consequences

- Macのスリープに左右されない定期同期の可能性を検証できる。
- 認証情報の保管境界が広がるため、Secretsの最小権限、ローテーション、監査が必要になる。
- Web画面・Bot対策・OTPにより、公式API連携より保守負担が大きい。
- 同期Workerを分離するため、デプロイ、Cron、監視、失敗通知の運用対象が増える。
- 本ADRがAcceptedになるまで、既存の要件FR-01（認証情報は信頼済みローカル環境のみ）と設計書のOption Dを正本とする。

## Action Items

1. [x] Browser Runの非機密起動PoCを実行する。
2. [x] Cron Triggerの`scheduled()`を架空fixtureで実行する。
3. [x] 認証情報なしでMoney Forwardログイン画面へ到達できることを確認する。
4. [x] 未認証ログイン画面のフォーム構造とCAPTCHA/OTP表示の有無を確認する。
5. [x] Cloudflare公式仕様のBrowser Run費用・制限・Bot対策・セッション保持を確認する。
6. [x] Money Forward ME公式利用規約の認証情報管理・自動接続に関する記載を確認する。
7. [ ] Money Forward側でBrowser RunのBot対策・OTP・セッション継続可否を確認する。
8. [x] Cloudflare Secrets / Secrets StoreへのMoney Forward認証情報保管と1回の実ログインPoCをユーザーが承認した。
9. [ ] Go判定後にのみ、`workers/finance-sync`の実装と実データ検証へ進む。

## 承認記録（2026-09-12）

- ユーザーは`おｋ`で、Money Forwardの認証情報をCloudflare Secretsへ保管し、実ログインPoCを1回実行することを承認した。
- 承認範囲は検証目的に限る。認証情報を会話・Git・ログへ出力しないこと、Geminiへ実データを送らないこと、D1へ実データを投入しないこと、本番Cronを有効化しないこと、ブラウザセッションを永続化しないことを不変条件とする。
- PoCではログイン成功、Bot対策、OTP要求、セッション失効の状態だけを分類し、画面本文・Cookie・取引明細・スクリーンショットは保存しない。
- 実データ同期、staging/active切り替え、1時間ごとの本番Cron、継続セッション運用は、PoCのGo/No-Goと別途のユーザー承認が完了するまで開始しない。

## 実ログインPoC試行結果（2026-09-12）

- PoC専用Workerを一時的に有効化し、認証済みの`POST /poc/login`を1回実行した。
- `/health`は200、未認証の`/poc/login`は401だった。認証済みの実ログイン試行はHTTP 400（本文なし）で、ログイン状態の分類結果は取得できなかった。
- 追加のログイン試行は、アカウントロックや不要な認証アクセスを避けるため行わない。PoC専用Workerは`POC_ENABLED=false`で再デプロイし、実行口を無効化した。
- この結果だけではGo判定に進めない。原因調査と再試行には、失敗原因を限定したうえでユーザーの明示承認を改めて得る。

## 再試行結果（2026-09-12）

- ユーザーの再試行承認後、Workerのエラーtailを併用して実ログインを1回だけ再試行した。
- 結果は前回と同じHTTP 400（本文なし）で、tailに分類可能なWorkerエラーイベントは現れなかった。ログイン画面の本文・Cookie・取引データは取得していない。
- 追加試行は行わず、PoC専用Workerは再び`POC_ENABLED=false`で無効化した。原因未解決のため、自動同期のGo判定および本番Cron実装へは進まない。

## Cloudflare公式仕様の確認結果（2026-09-12）

- Workers FreeはBrowser Runが1日10分、同時ブラウザ3、ブラウザ起動は20秒に1回、アイドルタイムアウトは60秒である。
- Workers Paidはブラウザ時間10時間/月を含み、超過分はブラウザ時間$0.09/時間。Browser Sessionsは同時ブラウザ数も課金対象となる。
- セッションは`keep_alive`で最大10分までアイドル時間を延長できる。明示的に`browser.close()`して使用量を解放する。
- Browser Runのリクエストは常にBotトラフィックとして識別される。対象サイト側のBot対策・CAPTCHA・OTPを回避できるとは限らない。

参照: [Limits](https://developers.cloudflare.com/browser-run/limits/)、[Pricing](https://developers.cloudflare.com/browser-run/pricing/)、[FAQ](https://developers.cloudflare.com/browser-run/faq/)

## Money Forward ME公式利用規約の確認結果（2026-09-12）

- 第11条では、マネーフォワードID・パスワードを利用者が管理し、貸与・譲渡・名義変更・売買・質入れや、方法を問わない第三者利用を禁止している。
- 同条では、Money Forwardのアグリゲーション先コンテンツサイトについて、口座情報取得のためのID・パスワード自動入力やAPI等による自動接続を、利用者自身が本サービスを利用して行う行為として扱い、その結果の責任を利用者が負うとしている。
- これらはCloudflare保管の可否を直接許諾する記載ではない。実装前に、規約・契約・アカウント保護上のリスクをユーザー自身が確認し、採用可否を決める。

参照: [マネーフォワード ME 利用規約](https://moneyforward.com/terms)
