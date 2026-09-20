# rvw

**説明を読み、根拠のコードを開き、自分で変更を判断する。**

差分は追えたけれど、変更後に何が起こるのか、周りのコードとどうつながるのかが掴めない。
rvwは、そんなときにGitHubのPull Requestを手元のブラウザで読むためのツールです。
PR本文、差分、変更されていないファイルを行き来し、疑問をコードにコメントとして残せます。
Codex / Claude Codeと実装を進める場面でも、人間が書いたコードを読む場面でも使えます。

外部のAgentにコードへのリンク付きの説明を作ってもらえば、説明を残したまま根拠を横に開けます。
説明を受け入れるか、さらに調べるか、修正を求めるかは、読む人が判断します。

![注文保存に失敗した場合の説明を左に残し、右で決済を取り消す条件のコードを確認しているrvwの画面](https://raw.githubusercontent.com/a9n-shoji/rvw/main/docs/images/review-evidence.png)

「決済の承認後、注文を保存できなかったら？」——説明のリンクから、注文の有無と決済状態を確かめる処理へ。
画面は同梱デモの架空の注文サービスPRです。実際のrvwを撮影しています。

## 一つの疑問を、コードで確かめる

1. **何を確かめたいかを決める。** PR本文と変更箇所を読み、たとえば保存失敗時の処理に目を向けます。
2. **説明と実装を並べる。** Agentが作る、コードへのリンク付きの読み物を **Walkthrough** と呼びます。
   説明内のリンクを `Cmd` / `Ctrl` を押しながらクリックすると、根拠を右ペインに開けます。
3. **残った疑問をコメントにする。** この例では、決済状態が確定しない場合に `retry-later` を返すことを確認し、
   「いつまで再試行するのか」を質問します。参照をコピーすれば、同じ箇所をAgentへ渡せます。

![決済状態が確定しない場合のretry-laterを読み、再試行の期限についてコード行に日本語のコメントを残した画面](https://raw.githubusercontent.com/a9n-shoji/rvw/main/docs/images/review-comment.png)

取り消す条件を確かめた後、判断できていない点を行コメントに残す。コメントは手元のrvwに保存されます。

必要なら、関連するファイルや処理を図から辿る **Structure** もAgentに作成を依頼できます。
図の要素や関係からコードを開き、説明の途中で周辺の実装を確かめられます。
rvwがAIを内蔵したり、Agentを起動したりするわけではありません。

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
rvw skill install codex
# Claude Codeを使う場合はこちら
rvw skill install claude
rvw skill status
```

Agent側のセッションでSkillを利用できる状態にし、rvwで開いたPRのURLを添えて依頼します。
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
rvw Skillを使って、次のコメントの疑問を調べ、根拠のコードへのリンク付きで
rvwの同じコメントに返信してください。今回はコードの変更やpushは不要です。

［ここにコピーした rvw://comment/… を貼る］
```

返信から根拠を読み、納得できたら **解決** を押します。
修正を依頼する場合や、PR全体の説明の構成を任せる場合は、
[利用ガイド](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md)へ進んでください。

## 使う前に知っておくこと

- **コメントはGitHubへ投稿されません。** コメント、返信、Walkthrough、Structureはローカルに保存します。
  GitHubからはPR情報とコミットを取得します。共有レビューやApprove・MergeはGitHubで行います。
- **説明の正しさは保証しません。** rvwは参照先のコミット・ファイル・行を検証しますが、説明の意味はコードと照合してください。
  古い説明やコメントを最新コードへ確実に対応付けられない場合は、参照時点や `Outdated` を表示します。
- **完全なオフライン専用ツールではありません。** 初回登録・同期とPR本文の対応するGitHub添付画像の取得では外部通信します。
  登録済みPRは保存済みデータとGitオブジェクトで再表示できます。Agentへ渡す情報は、そのAgentの権限・送信先・設定に従います。
- **GitHub Enterprise、Closed／Merged PRの新規登録は未対応です。** 登録後にClosed／MergedになったPRは引き続き表示・同期できます。
- **ローカル環境が必要です。** 対象リポジトリやrvwのローカル接続を使えないクラウドAgentは連携対象外です。
  rvw自身はコード編集、テスト実行、commit、pushを行いません。
- PRタイトルと本文は、常に**最後に成功したGitHub同期時点の内容**です。過去のコミットを選んでも過去のPR本文には戻りません。

保存場所、ファイル表示の制限、同期に失敗したときの確認は[利用ガイド](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md)にまとめています。

## 手元のPRを使わずに試す・詳しく知る

ソースから `pnpm demo` を起動すると、上の画面と同じ注文サービスPRを試せます。
GitHub認証やAgentは不要です。[デモの起動と操作手順](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md#デモで同じ疑問を追う)を参照してください。

- [利用ガイド](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md)：PRを読む、説明を頼む、コメントを渡す、修正後を確認する。
- [CLI protocol](https://github.com/a9n-shoji/rvw/blob/main/docs/cli-protocol.md)：Agentや自動化向けのコマンドとJSON仕様。
- [実装仕様](https://github.com/a9n-shoji/rvw/blob/main/docs/implementation-spec.md) / [設計](https://github.com/a9n-shoji/rvw/blob/main/docs/architecture.md)：参照解決、保存、描画などの保証。
- [開発・問い合わせ](https://github.com/a9n-shoji/rvw/blob/main/CONTRIBUTING.md) / [互換性](https://github.com/a9n-shoji/rvw/blob/main/docs/compatibility.md) / [セキュリティ](https://github.com/a9n-shoji/rvw/blob/main/SECURITY.md)。

ライセンスは[MIT](https://github.com/a9n-shoji/rvw/blob/main/LICENSE)です。
