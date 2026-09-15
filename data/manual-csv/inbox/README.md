# 手動CSV置き場

Money ForwardからダウンロードしたCSVを、このフォルダへ置きます。

- CSV本体はGitへ登録されません。
- 「収入・支出詳細」形式（Shift_JIS）にも対応しています。
- 詳細CSVでは、日付・金額・大項目だけを月次集計に使います。内容・金融機関・メモ・IDは保存しません。
- CSVのメモ・明細はインポート結果やログへ出しません。
- remote D1へ投入する前に、件数とSQL内容を確認します。

置いたCSVのパス：

```text
/Users/fukurosejun/Documents/Claude-Workspace/02_projects/002_Private/fukuchan-app/data/manual-csv/inbox/<ダウンロードしたCSV名>.csv
```

置いたあと、CSVの絶対パスをふくちゃんへ伝えれば、まずdry-runで確認します。CSVの中身をチャットへ貼る必要はありません。
