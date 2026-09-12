# ADR-002：手動CSVなしの家計データ自動同期

**Status:** Proposed（ユーザー承認待ち）  
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
5. 実データへのログイン・取得は、PoCのGo判定とユーザーの認証情報保管承認が済むまで行わない。

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

1. [ ] Browser Runの非機密起動PoCを実行する。
2. [ ] Cron Triggerの`scheduled()`を架空fixtureで実行する。
3. [ ] Browser Runの費用・制限・Bot対策・セッション保持を確認する。
4. [ ] Cloudflare Secrets / Secrets StoreへのMoney Forward認証情報保管をユーザーが承認するか決める。
5. [ ] Go判定後にのみ、`workers/finance-sync`の実装と実データ検証へ進む。
