###### 2026-09-05 Cloudflare移行計画策定

## 背景

[Issue #2](https://github.com/fukurose-jun02/fukuchan-knowledge/issues/2)で整理されていたCloudflare移行方針を踏まえ、ユーザーからボリューム感の相談を受けた。バックエンド（Cloud Run/FastAPI）・フロントエンド（GitHub Pages）ともに小規模でステートレスな構成のため、半日程度で移行可能と見積もり、[Issue #3](https://github.com/fukurose-jun02/fukuchan-knowledge/issues/3)を作成した上で開発文書ワークフローに着手した。

## 実施内容

1. `fukuchan-app/docs/`に`requirements.md`・`design.md`・`implementation-plan.md`を作成
2. 1回目のレビュー（`tasks/todo.md`）で7点の指摘を受け、全文書を改訂
   - サーバー側認証の欠如、Pages+Worker分離とWorkers単体構成の比較（ADR）、`.dev.vars`運用、API契約の正規化（日付注入がフロントエンド側の処理だったという誤りを発見・修正）、独立した切り戻し経路、運用限界（入力上限・レート制限・fail-closed・タイムアウト）、完了条件の拡張
   - フロント・バックエンドの構成はユーザーに確認の上、**Workers単体（Static Assets）に統合**する方針で決定
3. 2回目のレビュー（再レビュー、`tasks/todo.md`追記）でさらに5点の必須修正・6点の追加修正を受け、再改訂
   - 最重要の発見：フロントエンド（`index.html:563`）に正解PIN`CORRECT_PIN = '1122'`が直書きされたままだった。1回目の改訂で追加した「サーバー側認証」も、PINそのものをそのまま送る方式だったため、この根本問題を解消できていなかった
   - `/auth`エンドポイントを新設し、PINをフロントから完全に排除。HMAC署名付きトークンを発行する方式に変更
   - `workers.dev`（ゾーンなし）ではCloudflareのWAF Rate Limiting Rulesが使えないという技術的誤りを修正し、Workers Rate Limitingバインディングに変更
   - mainブランチが現在もGitHub Pages本番として稼働中であることを踏まえ、作業ブランチ＋タグでの安全な移行手順に変更

## 気づき・教訓

- 開発文書は一度作って終わりではなく、外部レビューで実装の実態（既存コードの正確な挙動）と照合することで、設計者自身も気づいていなかった誤り（日付注入の主体の勘違い、PINが実は完全に露出していた点）が発見できた
- インフラの技術詳細（Cloudflareのレート制限がゾーンの有無で使える機能が変わる等）は、設計時点の思い込みで書かず、実装直前に公式ドキュメントで確認する前提を文書に明記した

## 次のアクション

`implementation-plan.md`のフェーズ0（作業ブランチ・タグ作成）から実装に着手する。
