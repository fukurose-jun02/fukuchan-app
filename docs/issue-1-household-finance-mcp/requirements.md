# 要件定義書：家計簿のMCP化

関連Issue: [fukurose-jun02/fukuchan-knowledge#1](https://github.com/fukurose-jun02/fukuchan-knowledge/issues/1)「家計簿をMCP化する」  
作成日: 2026-09-11  
状態: In progress（フェーズ1〜3の実装完了、Cloudflare認証・D1/KV作成・スキーマ適用・架空デモデータ投入・OAuth secrets設定・finance Workerデプロイ済み、実データ・root Worker有効化・実クライアント接続待ち）

## 1. 実現可能性

**条件付きで実現可能。**

ただし、Issueから参照されている`hiroppy/mf-dashboard`の旧v1 MCPサーバーを、そのまま現在の`fukuchan-app`へ移植する方式は採用しない。

- 旧v1のMCPは、ローカルSQLiteを読む`stdio`サーバーであり、Node.jsのネイティブSQLiteモジュールを使う。現在のCloudflare Workerへ直接載せる前提ではない。
- 参照実装の現行v2は外部MCPを廃止し、Playwright crawler・SQLite・WebアプリをDocker Composeで常時稼働させる方式へ移行している。
- Money Forward MEのデータ取得には、公式公開APIではなくWeb画面の自動操作を使う。そのため、画面変更による故障、ログイン・OTP管理、利用条件の確認が必要になる。
- 一方、Cloudflare Workersでは、認証付きRemote MCP、D1、Worker間のService Bindingを利用できる。この部分は現在の`fukuchan-app`と相性がよい。

推奨構成は次のとおり。

1. 信頼済みのローカル環境でMoney Forward MEのデータを取得する。
2. AIへ渡してよい読み取り専用データだけをCloudflare D1へ同期する。
3. 別WorkerのRemote MCPから、用途を限定した集計ツールとして提供する。外部接続はGitHub OAuthで保護する。
4. `fukuchan-app`は公開MCP URLを経由せず、Service Bindingで同じ照会機能を利用する。Geminiへは選択された集計結果のみを渡す。

## 2. 背景・課題

現在のふくちゃんトークは、Privateリポジトリ内の`knowledge/finance.csv`をGitHub Contents APIで読み、他のナレッジと一緒にGeminiへ渡している。

現行CSVは`年月・カテゴリ・金額・メモ`の月次集計であり、更新は手作業である。そのため、次の課題がある。

- 最新の家計状況が自動反映されない。
- 日付単位の記録がないため、「今月の途中経過」と「先月の同じ日まで」を正確に比較できない。
- 口座残高、前月比較、資産推移など、CSVにない質問へ正確に答えられない。
- 家計データ全体を毎回LLMへ渡すため、データ量が増えるほどコストとプライバシーリスクが増える。
- 「いつ取得したデータか」が回答から分からず、古い値を最新値として扱う可能性がある。

## 3. 対象ユーザー

- 主利用者：ふくちゃんトークの管理者本人
- 閲覧利用者：管理者が許可した家族
- 外部MCP利用者：管理者が明示的に接続を許可したClaude、ChatGPT等のMCPクライアント

## 4. 目的・ゴール

### ユーザーゴール

- 自然な質問で、月次収支・カテゴリ別支出・資産概要を確認できる。
- 回答にデータの基準日時が表示され、最新性を判断できる。
- Money Forward MEの認証情報をAIやCloudflareへ渡さずに利用できる。

### 成功条件

1. 定義済みの代表質問10件に対して、元データと一致する回答を10件すべて返せる。
2. 「今月の食費は先月に比べてどう？」を、日付範囲を明示した同期間比較として返せる。
3. 同期元ホストが稼働している場合、最終同期から24時間以内のデータを提供できる。
4. MCPの全ツールが読み取り専用で、Money Forward MEやD1を書き換えるツールを公開しない。
5. Publicリポジトリ、GitHub Actionsログ、Workers Logsへ、認証情報・金融明細・口座番号を出さない。
6. 未認証の外部MCPクライアントから家計データを取得できない。

## 5. スコープ

### P0：最初のリリースに含める

- Money Forward MEから取得したデータの読み取り専用同期
- 月次収支、カテゴリ別集計、資産カテゴリ別集計、データ更新日時の照会
- 今月途中の支出と先月の同日までの支出を比較する同期間比較
- 認証付きRemote MCPサーバー
- `fukuchan-app`からの家計ツール利用
- 同期失敗・古いデータ・データ欠落を明示するエラー処理
- 契約テスト、ツール評価テスト、同期データ検証

### P1：P0安定後に追加する候補

- 支出傾向、固定費・変動費の分析
- 取引明細の限定検索（最大件数、期間、カテゴリを必須化）
- 同期結果の通知
- 家族ごとの表示範囲や権限分離

### P2：将来検討

- 予算との比較
- 資産シミュレーション
- 異常支出の検知
- 手動CSVインポート以外の代替同期経路

### 対象外

- Money Forward ME上の取引・カテゴリ・口座情報の更新
- 振込、売買、支払い等の金融操作
- `mf-dashboard`の全画面・全分析機能の再実装
- LLMへ任意SQLを生成させて実行する機能
- Money Forward クラウド会計向け公式MCPの利用。今回は個人向けMoney Forward MEが対象であり、別製品である。
- 投資判断、税務判断、将来収益を保証する助言

## 6. ユーザーストーリー

### 管理者

- 管理者として、Money Forward MEのデータを定期同期したい。手作業で`finance.csv`を更新しなくて済むため。
- 管理者として、同期成功時刻と件数を確認したい。回答に使われたデータが正常か判断するため。
- 管理者として、MCPへ接続できるユーザーを限定したい。金融情報を第三者へ公開しないため。
- 管理者として、同期元のログイン情報をローカルの秘密管理から出したくない。漏えい時の影響を限定するため。

### 家族利用者

- 家族利用者として、「先月の食費はいくら？」と質問したい。画面を探さずに家計を確認するため。
- 家族利用者として、「今月の収支は？」と質問したい。現在の支出ペースを把握するため。
- 家族利用者として、「今月の食費は先月に比べてどう？」と質問したい。今月の途中経過を同じ経過日数で比較するため。
- 家族利用者として、回答の基準日時を知りたい。未反映の取引があり得ることを理解するため。
- 家族利用者として、データが古い場合は推測回答ではなく明確な注意を受けたい。誤った金額を信じないため。

### 外部MCP利用者

- 認証済み利用者として、Claude等から家計の集計値を照会したい。同じデータを複数のAIクライアントで安全に利用するため。

## 7. 機能要件

### P0 Must-Have

| ID | 要件 | 受け入れ基準 |
|---|---|---|
| FR-01 | 同期処理はMoney Forward MEの認証情報を信頼済みローカル環境でのみ使用する | 認証情報・OTP・ブラウザセッションがCloudflare、Publicリポジトリ、LLMへ送信されない |
| FR-02 | 同期は新しいデータ一式の検証完了後に切り替える | 途中失敗した同期が現行スナップショットを置き換えない |
| FR-03 | 各同期に`sync_id`、取得開始・完了日時、件数、状態を記録する | MCPの`get_data_freshness`で直近成功時刻と状態を取得できる |
| FR-04 | Remote MCPはStreamable HTTPの`/mcp`で提供する | 対応クライアントから接続し、ツール一覧と実行結果を取得できる |
| FR-05 | 外部MCPはOAuth認証を必須とする | 未認証リクエストは家計データを返さない |
| FR-06 | P0では5つの読み取りツールだけを公開する | 下記ツール以外、書き込み・任意SQLツールが存在しない |
| FR-07 | `fukuchan-app`はService Binding経由で照会する | 公開MCP URLや外部OAuthを経由せず、同一Cloudflareアカウント内で結果を取得できる |
| FR-08 | Geminiへは質問への回答に必要な集計結果だけを渡す | D1全体、認証情報、無関係な取引をプロンプトへ含めない |
| FR-09 | 回答は基準日時を含む | 家計回答に`as_of`または最終同期時刻が含まれる |
| FR-10 | データ欠落・同期失敗時はfail-closedにする | 値を推測せず、「取得不可」または「データが古い」と返す |
| FR-11 | 「今月と先月」の自然言語比較は、Asia/Tokyoの当日までの同期間を既定にする | 9月11日に質問した場合、9/1〜9/11と8/1〜8/11を比較し、対象期間を回答へ含める |
| FR-12 | 同期間比較は日次集計を使用し、日次データがない場合は計算結果を返さない | 月次集計しかない場合は`unsupported_granularity`相当の案内を返し、月次全期間の値で代用しない |

### P0 MCPツール

| ツール | 目的 | 主な入力 |
|---|---|---|
| `get_data_freshness` | 最終同期日時・状態・対象期間を取得 | なし |
| `get_monthly_summary` | 指定月の収入・支出・収支を取得 | `month: YYYY-MM` |
| `get_category_breakdown` | 指定月のカテゴリ別収支を取得 | `month`, `direction` |
| `compare_months` | 2か月の収支・カテゴリを比較。今月を含む自然言語比較は同日までを既定とする | `base_month`, `compare_month`, `category`省略可、`direction`省略可、`period_mode`省略可 |
| `get_asset_summary` | 基準日時点の資産・負債をカテゴリ別に取得 | `as_of`省略可 |

すべてのツールは、結果件数、通貨、基準日時、データ鮮度状態を返す。

### 比較期間の既定ルール

- `period_mode=auto`を既定とする。
- `base_month`がAsia/Tokyoの現在月である場合、当月1日から当日までを比較する。`compare_month`側は同じ日を終了日とし、その月に存在しない日付なら月末へ丸める。
- `base_month`が過去月の場合は、`auto`では月初から月末までの全期間を比較する。任意の同期間比較は`period_mode=month_to_date_same_day`で明示する。
- 「今月の食費」は`category=食費`、`direction=expense`として扱い、回答には両期間の開始日・終了日、金額、差額、増減率を含める。
- 同期済みデータの最終日が比較終了日より前の場合は、鮮度警告を付ける。日次データ自体がない場合はFR-12に従い、値を推測しない。

## 8. 非機能要件

### セキュリティ・プライバシー

- Money Forward MEのID、パスワード、OTP、ブラウザ保存状態はローカルの秘密管理だけに保存する。
- Cloudflareへ同期するのは、用途を定義した構造化データだけとする。
- P0では取引摘要・口座番号・カード番号を同期しない。
- Remote MCPは認証なしで公開しない。
- `fukuchan-app`の既存PIN認証を、外部MCPの認証として流用しない。
- ログには金額、明細、質問本文、ツール結果を出さず、`sync_id`、処理時間、件数、エラーコードだけを記録する。
- 取得用、D1同期用、MCP認証用の資格情報を分離し、最小権限にする。

### 正確性

- 金額は整数の円として扱い、浮動小数点で計算しない。
- 振替・対象外取引の扱いを固定し、同じ取引を収入と支出へ二重計上しない。
- 月境界はAsia/Tokyoで判定する。
- 集計値は同期元SQLiteとの照合テストを行う。

### 可用性・性能

- MCPツール単体の目標応答時間は、通常時p95 3秒以内とする。
- 最終同期から24時間を超えた場合は`stale`警告を返す。
- 最終同期から72時間を超えた場合、最新値と断定せず、同期確認を促す。
- 同期元ホスト停止中も直近の成功データは閲覧可能とする。

### 保守性

- upstreamの`mf-dashboard`はコミットまたはリリースを固定し、更新は検証後に行う。
- データ取得、データ変換、MCP照会、ふくちゃん回答生成を別モジュールに分離する。
- P0のツール数を抑え、ツール説明と評価データを同じリポジトリで管理する。

## 9. 成功指標

### 先行指標

- 代表質問10件のツール選択成功率：100%
- 元データとの金額一致率：100%
- 同期成功率：直近14日で90%以上（ホスト停止日は除外）
- staleデータを最新と断定した件数：0件
- 未認証アクセス成功件数：0件

### 遅行指標

- `finance.csv`の手動更新回数：運用開始30日後に0回
- 家計質問のうち「データ不足」で回答できない割合：運用開始30日後に10%未満
- 管理者が同期障害の原因を特定するまでの時間：15分以内

## 10. 受け入れシナリオ

1. Given 同期済みデータに対象月が存在する、When 「先月の食費」を質問する、Then 元データと一致する金額と基準日時を返す。
2. Given 対象月のデータが存在しない、When 月次収支を質問する、Then 別月の値を流用せず「データなし」と返す。
3. Given 最終同期から24時間を超えている、When 家計を質問する、Then 金額とともにstale警告を返す。
4. Given OAuth未認証、When `/mcp`へ接続する、Then 家計ツールやデータを取得できない。
5. Given 同期処理が途中で失敗する、When MCPツールを呼ぶ、Then 直前の成功スナップショットを参照し、失敗中データは表示しない。
6. Given Money Forward ME側の画面変更でcrawlerが失敗する、When 管理者が状態を確認する、Then秘密情報を含まないエラーコードと最終成功時刻を確認できる。
7. Given ふくちゃんが家計以外の質問を受ける、When Geminiが応答する、Then家計ツールを不要に呼ばない。
8. Given 現在日が2026-09-11で日次データがある、When 「今月の食費は先月に比べてどう？」と質問する、Then 2026-09-01〜09-11と2026-08-01〜08-11の食費を比較し、金額・差額・増減率・基準日時を返す。
9. Given 比較先の月に当日と同じ日付がない、When 同期間比較を行う、Then 比較先の終了日を月末へ丸め、その期間を回答へ表示する。
10. Given 月次集計しか存在しない、When 今月途中と先月同日までの比較を質問する、Then 月次全期間の値を代用せず、日次データが必要であることを返す。

## 11. 制約・依存関係

- Money Forward MEには、本件で利用できる個人向け公式公開APIを前提にしない。公式のMoney Forward クラウドAPI/MCPは別製品である。
- データ取得は非公式のWeb自動操作に依存するため、継続動作は保証されない。
- 現行`mf-dashboard`の本番構成にはDocker Desktop、1Password Service Account、常時起動可能なホストが必要である。
- Cloudflare側ではRemote MCP用Worker、D1、OAuth設定、Service Bindingを追加する。
- 金融データをGeminiへ送る範囲は、集計結果・鮮度・基準日時だけとする（ユーザー判断済み）。

## 12. 実装前の未決事項

### ブロッキング

1. 同期元を常時起動できるMac等へ置けるか。置けない場合は、P0を手動CSVインポートから開始する。
2. P0で扱う範囲を「日次・月次・カテゴリ・資産の集計のみ」としてよいか。取引明細は既定で除外する。
3. Money Forward MEのWeb自動操作を個人利用として継続するリスクを受容するか。

以下は決定済みのため、ブロッキング項目から除外する。

- 外部MCPの認証方式：GitHub OAuth
- Geminiへ送る範囲：質問に必要な集計結果・鮮度・基準日時のみ

### 非ブロッキング

- 同期時刻と回数
- 保持期間を13か月から延長するか
- 同期失敗通知をSlack、メール、GitHub Issueのどれにするか

## 13. 決定事項（フェーズ2着手時点）

- 外部MCPの認証はGitHub OAuthを採用する。OAuth ProviderはCloudflare公式の`@cloudflare/workers-oauth-provider`を利用し、P0では`mcp:read`だけを許可する。
- `fukuchan-app`からGeminiへは、質問に必要な集計結果・鮮度・基準日時だけを渡す。D1全件、取引摘要、口座番号、OAuth情報は渡さない。
- Remote MCPは公式`@modelcontextprotocol/server` v2のstateless `createMcpHandler`を利用し、`POST /mcp`をStreamable HTTPの入口とする。2026-07-28のmodern envelopeを優先しつつ、2025-era initializeはSDKのstateless互換モードで受ける。
- OAuth Providerが検証した`ctx.props`をMCP SDKの`authInfo`へ橋渡しする。ユーザー識別子はツール結果やログへ出さない。
- `fukuchan-app`の家計統合は`FINANCE_TOOL_ENABLED=true`と`FINANCE_SERVICE`の両方が揃った場合だけ有効にする。Geminiのfunction callは共有zod契約で検証し、Service Binding RPCを経由して同じquery層を呼ぶ。
- Geminiのfunction responseには集計結果・期間・鮮度・`as_of`だけを返し、`finance.csv`は同モードで同時投入しない。無効時は従来のCSV経路へ戻す。

残るブロッキング項目（同期元ホスト、Money Forward Web自動操作のリスク、upstream固定、Cloudflare本番設定）は、フェーズ4・5の前に確定する。

## 14. 参考資料

- [Issue #1: 家計簿をMCP化する](https://github.com/fukurose-jun02/fukuchan-knowledge/issues/1)
- [`mf-dashboard`現行README](https://github.com/hiroppy/mf-dashboard)
- [`mf-dashboard` v1 MCP README](https://github.com/hiroppy/mf-dashboard/blob/v1/apps/mcp/README.md)
- [`mf-dashboard`セットアップ](https://github.com/hiroppy/mf-dashboard/blob/main/docs/setup.md)
- [Cloudflare: Build a Remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Cloudflare: Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare D1: Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Money Forward クラウド開発者サイト](https://developers.biz.moneyforward.com/)
- [Money Forward ME利用規約](https://moneyforward.com/terms)
- [`@modelcontextprotocol/server` v2](https://www.npmjs.com/package/@modelcontextprotocol/server)
- [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
