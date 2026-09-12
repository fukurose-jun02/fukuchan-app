# Project Instructions

## GitHub Issue management

- このフォルダ内の作業で新しいGitHub Issueを作成する場合は、必ず `fukurose-jun02/fukuchan-app` リポジトリに作成する。
- `fukurose-jun02/fukuchan-knowledge` には、このフォルダのアプリ開発・デプロイ・インフラ・運用監視に関するIssueを作成しない。
- Issueを参照・更新・クローズする前に、Issue番号だけで判断せず、対象リポジトリの完全名を確認する。

## 開発文章の参照と更新

- 家計簿MCP（旧`fukuchan-knowledge#1`）の実装では、作業開始前に次の3文書を必ず参照する。
  - `docs/issue-1-household-finance-mcp/requirements.md`
  - `docs/issue-1-household-finance-mcp/design.md`
  - `docs/issue-1-household-finance-mcp/implementation-plan.md`
- 要件・設計・実装状況・判断・検証結果に変更があった場合、作業中に該当文書と`tasks/todo.md`を更新し、状態とReviewへ記録する。
- 実装と開発文章に矛盾がある場合は、実装を進める前に文章を更新して整合させる。未決事項は推測で確定せず、ブロッキング項目として記録する。
