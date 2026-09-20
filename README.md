# rvw

rvwは、GitHubのPull Requestを、差分と**その時点のコードベース全体**を行き来しながら読むためのツールです。
PR内のコミットを選び、変更された行からファイル全文、変更されていない呼び出し元やテストまで、手元のブラウザで確認できます。

基本的な使い方は次の4つです。

- **その時点のコードベースを読む。** 差分と全文を切り替え、変更されていないファイルも開いて検索できます。
- **参照リンクで根拠を確かめる。** 説明・図・コメントに付いたリンクから、対象のファイルと行を開けます。
- **左右に並べて読む。** 説明とコード、呼び出し元と呼び出し先を、タブに残して見比べられます。
- **コードにコメントを残す。** 変更のない行にも質問を書けます。Agentのコメント監視を起動しておけば、質問への応答と調査結果を同じ場所で読めます。

## 説明とコードを並べて読む

コードをどこから読めばよいか迷ったときは、Agentに参照リンク付きの説明を作ってもらえます。
rvwでは、その説明をコードと同じ画面に開き、気になる箇所から根拠のファイルや行へ進めます。説明には2つの形式があります。

- **Walkthrough** は、一つの疑問や処理を順に読む説明です。「決済の承認後に注文を保存できなかったらどうなるか」などを文章や図で説明し、各所に根拠のコードへのリンクを付けます。流れを読みながら、条件や処理をコードで確認できます。
- **Structure** は、ファイルや処理の関係を辿るための図です。どの処理がデータを読み書きするか、どのファイルに依存するかなどを、関連する要素や線からコードを開いて確認できます。

作成は、別に起動したCodex / Claude CodeへSkillを使って依頼します。rvwがAgentを起動したり、説明の正しさを判定したりすることはありません。
Agentなしでコードを読むこともできます。

下は注文サービスPRのデモです。**左にWalkthrough、右に参照先のコード**を開いています。
左の「決済の復旧処理」を選び、右の強調された行で、注文の有無と決済状態による分岐を確認している場面です。

![rvwの画面全体。左のWalkthrough「決済承認後に注文を保存できなかったら」と、右の参照先payment-reconciliation.tsを並べている](https://raw.githubusercontent.com/a9n-shoji/rvw/d9ea131858d1c6365060082ad971ef5aca43fa4b/docs/images/review-evidence.png)

<details>
<summary>参照リンクからコードを開き、質問への応答を見る（カーソル付きGIF・7.5秒）</summary>

![左のWalkthroughの参照リンクをカーソルで選び、右に復旧コードを開いて読み、再試行について質問し、Agentの確認中の応答と返信を読む操作](https://raw.githubusercontent.com/a9n-shoji/rvw/d9ea131858d1c6365060082ad971ef5aca43fa4b/docs/images/review-flow.gif)

左の説明を残したまま、右のコードで質問し、Agentの「🔎 確認中です…」が回答に変わるところまでを見せています。
実操作を短く編集し、カーソルとクリック位置を表示しています。応答は撮影用に用意した例で、実際のAgentの処理時間を示すものではありません。

</details>

## コードを確かめて質問を残す

このデモでは「決済承認後に注文を保存できなかったら」を開き、次の順に読みます。

1. 説明内の **決済の復旧処理** を `Cmd` / `Ctrl`＋クリックして、右ペインにコードを開きます。
2. 注文がある場合は終了し、決済状態が `voidable` の場合に取り消すことを確認します。
3. さらに読むと、`pending` や `unknown` の場合は `retry-later` を返しています。再試行の期限が分からなければ、その行に質問を残します。
4. Agentの返信と、返信に付いた参照リンクからコードや運用手順を確認します。

![再試行の期限を質問したコメントと、Codexの応答例。復旧処理と運用手順の参照リンク付きで回答している画面](https://raw.githubusercontent.com/a9n-shoji/rvw/d9ea131858d1c6365060082ad971ef5aca43fa4b/docs/images/review-comment.png)

Agent連携では、先に外部Agentで **rvw-watch-comments** を起動しておきます。
コメントを受け付けると **「🔎 確認中です…」** が付き、調査が終わると同じ投稿が回答に変わります。
応答にはCodex / Claude CodeなどのAgent名が表示され、自分の質問と区別できます。上の返信はデモ用の例です。
コメントと返信は手元のrvwに保存され、GitHubには投稿されません。

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

### 差分からコードベース全体を読む

1. 開いた `Pull Request.md` で変更の目的を確認します。
2. 上部の **対象commit** で、PR全体または確認したいコミットを選びます。
3. 左のファイル一覧から一つ選び、**変更** で差分、**全文** でその時点のコードを読みます。
4. **変更のないファイルも表示** をオンにし、呼び出し元やテストも開きます。`Cmd` / `Ctrl`＋クリックすると右ペインに並べられます。
5. 疑問のあるコード行にマウスを置き、行番号横の **＋** からコメントします。変更のない行にもコメントでき、複数行は＋からドラッグして選べます。

ファイル一覧や検索では、選択範囲の最後のコミット時点のリポジトリ全体を辿れます。表示するのはGitにコミットされたコードで、作業中の未コミット変更ではありません。
ここまでにAgentやSkillは必要ありません。

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
横のコードで条件や呼び出し先を確かめてください。

コメントする前に、外部Agentの別タスクで監視を起動します。

```text
rvw-watch-comments Skillを使って、rvwの新しいコメントと返信を監視してください。
今回は調査とrvwへの返信だけを行い、コード変更・commit・pushはしないでください。
監視を開始できたら知らせてください。
```

監視開始の知らせを待ってから、疑問のあるコード行にコメントします。
「🔎 確認中です…」が付けばAgentが受け付けています。調査後はその投稿が回答に置き換わるので、
返信とリンク先のコードを確認し、疑問が解消したら **解決** を押します。続けて質問する場合は同じコメントに返信できます。

監視には子Agentを使えるローカル環境が必要です。**全登録PRの新しいコメント・返信**が対象で、
新規に監視を始める前からあるコメントは拾いません。rvwを起動するだけでは監視は始まりません。
監視を使わず一件ずつ渡す方法や、修正を依頼する方法は、
[利用ガイド](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/docs/usage.md)にあります。

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

保存場所、ファイル表示の制限、同期に失敗したときの確認は[利用ガイド](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/docs/usage.md)にまとめています。

## デモと関連文書

ソースから `pnpm demo` を起動すると、上の画面と同じ注文サービスPRを試せます。
GitHub認証やAgentは不要です。[デモの起動と操作手順](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/docs/usage.md#デモで同じ疑問を追う)を参照してください。

- [利用ガイド](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/docs/usage.md)：PRを読む、説明を頼む、コメントへの応答を読む、修正後を確認する。
- [CLI protocol](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/docs/cli-protocol.md)：Agentや自動化向けのコマンドとJSON仕様。
- [実装仕様](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/docs/implementation-spec.md) / [設計](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/docs/architecture.md)：参照解決、保存、描画などの保証。
- [開発・問い合わせ](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/CONTRIBUTING.md) / [互換性](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/docs/compatibility.md) / [セキュリティ](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/SECURITY.md)。

ライセンスは[MIT](https://github.com/a9n-shoji/rvw/blob/7c054a0cc82205a01927bf4c26ac8560d0eeb853/LICENSE)です。
