###### 2026-09-05 Cloudflare移行計画_第3回レビュー反映

## 背景

Cloudflare移行の開発文書（`docs/requirements.md`・`design.md`・`implementation-plan.md`）に対し、Cloudflare公式ドキュメントの一次情報まで踏み込んだ3回目のレビュー（`tasks/todo.md`）を受けた。前回までの指摘（サーバー側認証・ADR・fail-closed等）はほぼ解消していたが、実装前に対処すべき指摘が新たに5点、実装時に詰める事項が7点見つかった。

## 実施内容

### 必須修正（5点）

1. **実PIN・実在人物データの記載を除去**：`requirements.md`・`design.md`に現行の実PIN（`CORRECT_PIN`の値）と、家族の実名・実際の誕生日を使った例文が残っていた。プレースホルダー・架空例へ置換し、「現行PINは既にPublicリポジトリで公開済み＝漏洩済み前提」として、移行時に新しい値へローテーションする要件を追加した
2. **レート制限の実現方式を訂正**：Cloudflare Workers Rate Limiting bindingは10秒/60秒の固定窓しか扱えず、かつ拠点ごとに分散したeventually consistentなカウンタである（[公式](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)）ため、当初案の「15分に5回」は実装不能だった。4桁PINを維持するかDurable Objectで厳密なロックアウトを組むかをユーザーに確認し、**4桁PIN維持＋60秒窓での抑止＋残余リスクの明記**という方針で確定した
3. **Secrets投入方法の見直し**：`wrangler secret put`を4回個別に呼ぶと、その都度即時デプロイが走り「一部だけ設定された中間状態」が順に公開されてしまう。コードとシークレットをまとめて1バージョンとして投入する方式に変更した
4. **入力上限のバイパス防止**：`Content-Length`ヘッダーは欠落・偽装が可能なため、実際に読み込んだUTF-8バイト数を積算して50KB上限を判定する方式に変更した
5. **Workers Logs設定の修正**：設定キーを現行仕様の`[observability] enabled = true`に修正し、ログ保持期間（Free3日/Paid7日）が2週間の検証期間より短いことを踏まえ、定期確認（2〜3日おき）を計画に追加した

### 実装時に詰める事項（7点、あわせて反映）

- Static Assetsの`directory`・`binding`・`run_worker_first`を`wrangler.toml`に明記する方針を追加
- テスト用パッケージを`@cloudflare/vitest-plugin`に確定
- GitHub/Geminiのタイムアウト応答を504、それ以外の異常応答を502に統一（従来テーブルの矛盾を解消）
- GitHub Pagesの転送ページ化はカットオーバー時の1回のみで、2週間後には行わないことを明文化
- Gemini APIキーの型確認をデプロイ前チェックに追加
- **30日Bearerトークンの`localStorage`保存**という当初案は、XSS一発で長期間有効なトークンが漏れるリスクがあったため、ADRで同一オリジンに統合した利点を活かし、**`HttpOnly; Secure; SameSite=Strict`Cookie（有効期限7日）**に設計変更。これによりXSSでのトークン窃取を構造的に防げるようになった
- `fukuchan-app/.gitignore`に`/fukuchan-knowledge/`を追加し、入れ子のPrivateリポジトリを誤って本リポジトリに取り込むリスクを別途解消（レビュー対象外だが同時に対応）

## 気づき・教訓

- 開発文書に実装例を書く際、実際の値（PIN・個人情報）をそのまま使うと、Private/Publicの区別に関わらずドキュメント自体が新たな漏洩経路になる。架空例・プレースホルダーを徹底する必要がある
- インフラの技術的な数値制約（レート制限の窓の長さ、ログ保持期間など）は、公式ドキュメントの一次情報で確認しないと「実装できない設計」を書いてしまう。今回のレビューはCloudflare公式ドキュメントを直接参照しており、精度の高い指摘につながった
- セキュリティ対策のトレードオフ（4桁PIN維持 vs 長いパスフレーズ、Durable Object導入の要否）は、エンジニアリングの都合だけで決めず、実際の利用者（家族）のUXを踏まえてユーザー自身に判断してもらうべき場面だった

## 次のアクション

3文書の改訂が完了。`implementation-plan.md`のフェーズ0（作業ブランチ・タグ作成）から実装に着手する。
