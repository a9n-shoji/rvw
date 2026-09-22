# rvw

GitHub Pull Request の差分だけでなく、**そのコミット時点のコードベース全体**を行き来しながらレビューするためのローカルビューアです。

変更行からファイル全体のコード、未変更の呼び出し元、テストコードまでを手元のブラウザで確認できます。

- **コードベース全体の探索**: 差分とファイル全文の切り替え、未変更ファイルの閲覧・全文検索に対応。
- **根拠コードへのジャンプ**: Walkthrough（解説文）やStructure（関係図）内のリンクから該当コードを開く。
- **2ペイン表示**: 説明とコード、呼び出し元と呼び出し先を左右に並べて比較。
- **ローカルコメント & Agent調査**: 変更のない行にもコメント可能。Codex や Claude Code に行単位で質問し、その場で調査結果を確認できる。

---

## インストールと起動

### 動作要件

- Node.js 24.15.0 以上
- Git
- [GitHub CLI (`gh`)](https://cli.github.com/)（対象PRへのアクセス権限およびGit認証が完了していること）
- PRのマージ先（base）リポジトリのローカルclone、またはそこから作成した Git worktree
  - ※ fork元リポジトリ単体のcloneでは利用できません。
- Claude Code でコメント監視を使う場合は、`Monitor` tool とサブAgentが利用可能な環境

### セットアップ

```bash
# GitHub CLI のセットアップ（未設定の場合）
gh auth login
gh auth setup-git

# インストール
npm install --global @a9n-shoji/rvw

# baseリポジトリへ移動して起動
cd /path/to/base-repository-clone
rvw doctor
rvw open https://github.com/owner/repository/pull/123
```

`http://127.0.0.1:43117` でブラウザが開きます。ブラウザのタブをすべて閉じると、サーバーも自動停止します。

---

## 基本的なレビューフロー

### 1. 差分とコードベースを行き来する

1. 開いた画面でコミットを選択し、左側のファイル一覧からファイルを開きます。
2. 上部の切り替えで **変更**（差分）または **全文**（選択コミット時点の内容）を表示します。
3. **変更のないファイルも表示** を有効にすれば、未変更ファイルも一覧や全文検索（`Cmd/Ctrl + Shift + F`）から参照可能。`Cmd/Ctrl + クリック` で右ペインに並べて開けます。
4. 任意の行番号の **＋** からコメントを追加できます（未変更行も可。ドラッグで複数行選択）。

### 2. Walkthrough（解説）とコードの突き合わせ

PR全体の流れを把握するために、Agentが生成した解説（Walkthrough）を左ペインに開き、リンクから右ペインに該当コードを呼び出せます。

![Walkthroughからコードを開き、コメントで質問する操作フロー](https://raw.githubusercontent.com/a9n-shoji/rvw/166871b5fbd78f258611553ca7c8acc0101737e2/docs/images/review-flow.gif)

- 解説文中のリンク（`Cmd/Ctrl + クリック`）から、実装行へ直接ジャンプします。
- 疑問点があればその場でコード行にコメントを残せます。

### 3. Structure（関係図）からの依存関係の把握

ファイルや処理の依存関係を図として可視化し、図中の要素やコネクタから該当コードを特定できます。

![Structureからコード参照を開く操作フロー](https://raw.githubusercontent.com/a9n-shoji/rvw/166871b5fbd78f258611553ca7c8acc0101737e2/docs/images/structure-flow.gif)

- 図中の **`</>`** アイコンを `Cmd/Ctrl + クリック` すると、呼び出し元や条件分岐の実装を右ペインに開きます。
- **1-hop / 2-hop** で着目したノードの周辺関係に絞り込み、**Fit** で全体表示に戻せます。

---

## Agent連携（Codex / Claude Code）

ローカルの Agent に Skill を登録することで、PRの構成図生成や、行コメントに対する調査・返信を自動化できます。

### 1. Skill のセットアップ

```bash
# Codex の場合
rvw skill install codex

# Claude Code の場合
rvw skill install claude
rvw skill status
```

### 2. Walkthrough / Structure の作成依頼

PRのURLとともに `rvw-review-compose` を実行させます。

```text
rvw-review-compose Skillを使って、次のPull Requestをレビューするための構成を検討し、
必要なStructureやWalkthroughをrvwに作成してください。

https://github.com/owner/repository/pull/123
```

### 3. コメントの監視と調査返信

Agent にコメント監視を開始させた状態でコード行にコメントを残すと、Agent が調査結果を該当行のスレッドに直接返信します。

```text
rvw-watch-comments Skillを使って、rvwの新しいコメントと返信を監視してください。
今回は調査とrvwへの返信だけを行い、コード変更・commit・pushはしないでください。
監視を開始できたら知らせてください。
```

![コメントに対するAgentの返信例](https://raw.githubusercontent.com/a9n-shoji/rvw/166871b5fbd78f258611553ca7c8acc0101737e2/docs/images/review-comment.png)

- コメント送信後、調査中は「🔎 確認中です…」と表示され、完了すると回答に置き換わります。
- 疑問が解消したら **解決** を押してクローズします。

---

## 仕様・注意点

- **完全ローカル管理**: コメント、返信、生成された Walkthrough / Structure はローカルに保存されます。**GitHub上のPRには一切投稿・送信されません**。Approve や Merge 等は通常通り GitHub 上で行ってください。
- **参照の検証**: rvw は指定コミット・ファイル・行が存在することのみを検証します。Agentが生成した解説自体の妥当性は保証しません。
- **接続要件**: 初回取得・同期時のみ GitHub への接続が必要です。取得済みのPRはオフラインでも表示可能です。
- **未対応環境**: GitHub Enterprise、および新規登録時点ですでに Closed / Merged になっているPRには非対応です（登録済みPRのクローズ追従は可能）。
- **変更操作の非保持**: rvw 単独でコード編集、テスト実行、Git コミット等を行う機能はありません。

---

## ショートカット一覧

※ `Cmd`（macOS） / `Ctrl`（Windows, Linux）

| 操作                             | ショートカット            | 補足                                           |
| :------------------------------- | :------------------------ | :--------------------------------------------- |
| ファイル・解説をクイックオープン | `Cmd/Ctrl + P`            | `↑`/`↓` で選択、`Enter` で開く                 |
| コードベース全体の全文検索       | `Cmd/Ctrl + Shift + F`    | 選択コミットのリポジトリ全体が対象             |
| ペイン内検索                     | `Cmd/Ctrl + F`            | 文書ペインを選択中に有効                       |
| 次／前の検索一致箇所             | `Enter` / `Shift + Enter` | 検索窓フォーカス時（`F3` / `Shift + F3` も可） |
| ファイル・参照先を右ペインに開く | `Cmd/Ctrl + クリック`     | 一覧、リンク、Structure上の参照に対応          |
| コメント・返信の投稿 / 保存      | `Cmd/Ctrl + Enter`        | 各入力欄                                       |
| コメント入力のキャンセル         | `Esc`                     | 未投稿内容を破棄                               |
| 前／次のタブへ移動               | `←` / `→`                 | タブヘッダーにフォーカス時                     |
| コミットの範囲選択               | `Shift + クリック`        | コミット一覧で範囲指定                         |
| Structure: ノードの詳細展開      | ノードをダブルクリック    | コード参照ボタン以外の部分                     |
| Structure: 拡大・縮小            | `Cmd/Ctrl + ホイール`     | ホイール単体はキャンバス移動                   |

---

## ドキュメント

ソースから `pnpm demo` を実行すると、デモ環境（認証・Agent不要）をローカルで試せます。

- [利用ガイド](https://github.com/a9n-shoji/rvw/blob/main/docs/usage.md)
- [CLI Protocol 仕様](https://github.com/a9n-shoji/rvw/blob/166871b5fbd78f258611553ca7c8acc0101737e2/docs/cli-protocol.md)
- [アーキテクチャ設計・実装仕様](https://github.com/a9n-shoji/rvw/blob/166871b5fbd78f258611553ca7c8acc0101737e2/docs/architecture.md)
- [コントリビューション](https://github.com/a9n-shoji/rvw/blob/166871b5fbd78f258611553ca7c8acc0101737e2/CONTRIBUTING.md) / [セキュリティ](https://github.com/a9n-shoji/rvw/blob/166871b5fbd78f258611553ca7c8acc0101737e2/SECURITY.md)
- [ライセンス (MIT)](https://github.com/a9n-shoji/rvw/blob/166871b5fbd78f258611553ca7c8acc0101737e2/LICENSE)
