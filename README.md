# rvw

rvwは、GitHubのPull Requestを手元のブラウザで読むためのツールです。
差分だけでは変更後の動きが分かりにくいときに、ファイル全文や、変更されていない呼び出し元・テストも開けます。

Codex / Claude Codeと使う場合は、Agentにコードへのリンク付きの説明を作ってもらい、説明と実装を並べて読めます。
疑問はコードの行にコメントとして残し、Agentへ渡して調査や修正を頼めます。Agentを使わずにコードを読むこともできます。

![決済承認後の注文保存失敗について、説明と根拠のコードへのリンクを読んでいるrvwの画面](https://raw.githubusercontent.com/a9n-shoji/rvw/main/docs/images/review-evidence.png)

同梱デモの注文サービスPRを開いた画面です。決済の承認後に注文を保存できなかった場合の説明から、復旧処理のコードへ移動できます。

<details>
<summary>説明からコメントまでの操作GIFを見る（13秒）</summary>

![日本語の説明を読み、決済の復旧コードを開き、再試行について質問を入力して投稿する4場面のGIF](https://raw.githubusercontent.com/a9n-shoji/rvw/main/docs/images/review-flow.gif)

実際に操作した「説明 → コード → 質問の入力 → 投稿」の4場面を順に表示します。

</details>

## 説明からコードを開く

コードへのリンクが付いた説明を **Walkthrough** と呼びます。
このデモでは「決済承認後に注文を保存できなかったら」を開き、次の順に読みます。

1. 説明内の **決済の復旧処理** を `Cmd` / `Ctrl`＋クリックして、右ペインにコードを開きます。
2. 注文がある場合は終了し、決済状態が `voidable` の場合に取り消すことを確認します。
3. さらに読むと、`pending` や `unknown` の場合は `retry-later` を返しています。再試行の期限が分からなければ、その行に質問を残します。

![決済状態が確定しない場合のretry-laterを読み、再試行の期限についてコード行に日本語のコメントを残した画面](https://raw.githubusercontent.com/a9n-shoji/rvw/main/docs/images/review-comment.png)

コメントは手元のrvwに保存されます。参照をコピーしてAgentへ渡すと、対象のコードと質問を読んで返信できます。

ファイルや処理の関係を図から辿りたい場合は、**Structure** の作成もAgentに依頼できます。図の要素や関係からコードを開けます。
説明や図を作るのは、利用者が別に起動したAgentです。rvw自身にAI機能はありません。

## インストールしてPRを開く

必要なものは次のとおりです。

- Node.js **24.15.0以上**、Git、[GitHub CLI](https://cli.github.com/)。ブラウザはローカルで開きます。
- GitHub CLIで対象PRを読める認証と、Gitで取得できる権限。
- PRの**マージ先（base）リポジトリのclone**、またはそのcloneから作ったGit worktree。
  forkからのPRも読めますが、fork側だけのcloneでは開けません。
- 新規登録するPRは **github.com上のOpenまたはDraft**。初回取得と同期にはネット接続が必要です。

```bash
# 未設定の場合に実行
gh auth login
gh auth setup-git

# 同名の別パッケージと区別するため、scopeを含める
npm install --global @a9n-shoji/rvw

cd /path/to/base-repository-clone
rvw doctor
rvw open https://github.com/owner/repository/pull/123
```

`/path/to/base-repository-clone` とPRのURLは、自分の対象に置き換えてください。
`rvw doctor` はGit・GitHub認証・リポジトリ・保存先への書き込みなどを診断します。
現在のブランチに対応するPRを初めて開くときは `rvw open` だけでも指定できます。
登録済みPRを確実に選ぶにはURLを指定してください。

通常は `http://127.0.0.1:43117` でブラウザが開き、端末に制御が戻ります。
最後のrvwタブを閉じると、少し待ってサーバーも終了します。

## 最初のレビューを進める

### Agentなしで読む

1. 開いた `Pull Request.md` で変更の目的を確認します。
2. 左のファイル一覧から一つ選び、上部の **変更** で差分、**全文** で変更後のコードを読みます。
3. **変更のないファイルも表示** をオンにし、呼び出し元やテストも開きます。ファイル名で絞り込めます。
4. 疑問のあるコード行にマウスを置き、行番号横の **＋** からコメントします。複数行は＋からドラッグして選べます。

ここまでにAgentやSkillは必要ありません。表示するのはGitにコミットされたコードで、作業中の未コミット変更ではありません。

### Agentの説明から読み始める

同じマシンで動き、対象リポジトリとrvw CLIを使えるCodexまたはClaude Codeを用意します。
使う方のSkillをインストールしてください。

```bash
# Codexを使う場合
rvw skill install codex

# Claude Codeを使う場合
rvw skill install claude
rvw skill status
```

Agent側でSkillが読み込まれていることを確認し、rvwで開いたPRのURLを添えて依頼します。
下の角括弧の部分を、自分が確かめたいことに置き換えます。

```text
rvw-walkthrough Skillを使って、https://github.com/owner/repository/pull/123 の
「［例：保存に失敗したときの処理］」を説明するWalkthroughをrvwに作成してください。
コミット済みの実装と関連するテストを調べ、説明から根拠のコードを開けるようにしてください。
確認できない点は明記してください。今回はコードの変更は不要です。
```

作成後、左の **ウォークスルー** から説明を開きます。気になる説明のリンクを `Cmd` / `Ctrl`＋クリックし、
横のコードで条件や呼び出し先を確かめてください。疑問が残ったら、そのコード行にコメントします。
コメントの **… → 参照をコピー** を選び、Agentへ次のように渡します。

```text
rvw Skillを使って、次のコメントについて調査し、rvwの同じコメントに返信してください。
確認したコードへのリンクも付けてください。今回はコードの変更やpushは不要です。

［ここにコピーした rvw://comment/… を貼る］
```

返信とリンク先のコードを確認し、疑問が解消したら **解決** を押します。
修正を依頼する場合や、PR全体の説明の構成を任せる場合は、
[利用ガイド](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md)へ進んでください。

## 使う前に知っておくこと

- **コメントはGitHubへ投稿されません。** コメント、返信、Walkthrough、Structureはローカルに保存します。
  GitHubからはPR情報とコミットを取得します。共有レビューやApprove・MergeはGitHubで行います。
- **説明はコードと照合してください。** rvwが検証するのは、参照先のコミット・ファイル・行が存在することです。説明の内容が正しいかどうかは判定しません。
  古い説明やコメントを最新コードへ確実に対応付けられない場合は、参照時点や `Outdated` を表示します。
- **初回登録・同期にはGitHubへの接続が必要です。** PR本文にある対応形式のGitHub添付画像も取得します。
  登録済みPRは保存済みデータとGitオブジェクトで再表示できます。Agentへ渡す情報は、そのAgentの権限・送信先・設定に従います。
- **GitHub Enterprise、Closed／Merged PRの新規登録は未対応です。** 登録後にClosed／MergedになったPRは引き続き表示・同期できます。
- **ローカル環境が必要です。** 対象リポジトリやrvwのローカル接続を使えないクラウドAgentは連携対象外です。
  rvw自身はコード編集、テスト実行、commit、pushを行いません。
- PRタイトルと本文は、常に**最後に成功したGitHub同期時点の内容**です。過去のコミットを選んでも過去のPR本文には戻りません。

保存場所、ファイル表示の制限、同期に失敗したときの確認は[利用ガイド](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md)にまとめています。

## デモと関連文書

ソースから `pnpm demo` を起動すると、上の画面と同じ注文サービスPRを試せます。
GitHub認証やAgentは不要です。[デモの起動と操作手順](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md#デモで同じ疑問を追う)を参照してください。

- [利用ガイド](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md)：PRを読む、説明を頼む、コメントを渡す、修正後を確認する。
- [CLI protocol](https://github.com/a9n-shoji/rvw/blob/main/docs/cli-protocol.md)：Agentや自動化向けのコマンドとJSON仕様。
- [実装仕様](https://github.com/a9n-shoji/rvw/blob/main/docs/implementation-spec.md) / [設計](https://github.com/a9n-shoji/rvw/blob/main/docs/architecture.md)：参照解決、保存、描画などの保証。
- [開発・問い合わせ](https://github.com/a9n-shoji/rvw/blob/main/CONTRIBUTING.md) / [互換性](https://github.com/a9n-shoji/rvw/blob/main/docs/compatibility.md) / [セキュリティ](https://github.com/a9n-shoji/rvw/blob/main/SECURITY.md)。

ライセンスは[MIT](https://github.com/a9n-shoji/rvw/blob/main/LICENSE)です。
