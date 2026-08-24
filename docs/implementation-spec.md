# rvw implementation specification

**基準日:** 2026-08-09
**対象:** Phase 1のローカル実用品とPhase 2の配布
**一次仕様:** この文書を実装・テスト・README・Skill契約のsource of truthとする。commitモデルへの
移行は、それと無関係な既存のViewer、comment、CLI、security、配布要件を破棄しない。

## 1. プロダクトの定義

`rvw`は、GitHub Pull Requestが作るsoftwareと、GitHub repositoryのdefault branchにある現在の
softwareを、人間が文書とexact Git sourceから理解し、次の判断をAgentへ返すためのローカルWeb
viewerである。

利用者は最新PRタイトル・本文から変更の意図を読み、PRを構成するGit commitから実装の進行を読み、
変更箇所を入口に選択commit時点のrepository全体へ移動する。コード全文、変更されていないfile、
検索結果を含む任意の文書へコメントでき、その判断をCodex / Claude Codeへ共通Skill経由で受け渡す。
Agentが実装やarchitectureを説明する場合は、commit固定のWalkthroughとしてcode referenceと
Mermaid図を提示できる。どの参照をいつ開くかは人間が選び、rvwの最大二ペインのdocument workspaceで確認する。

diffは変更を見つけるlensであり、レビュー対象の境界ではない。レビュー対象は選択したcommitが作る
repositoryの状態と、その状態を説明するPull Request全体である。

```text
Pull Request
├─ 最新のPull Request.md
├─ PR commit一覧
├─ 選択範囲のlatest側commitのrepository全体
├─ 選択した連続commit範囲のdiff
├─ Agentが提示したWalkthroughとexact code reference
└─ コメント
```

```text
Repository Review（repositoryごとに一件）
├─ GitHub default branchのexact source
├─ repository全体
├─ 明示的に登録したGitHub Issue documents
├─ Agentが提示したWalkthroughとexact code reference
└─ コメント
```

Pull Request ReviewとRepository Reviewは独立する。同じIssueを双方へ登録できるが、membership、Comment、
Walkthroughをコピー・移動・統合せず、Repository Reviewをfake Pull Requestとして表現しない。

コード履歴の正本はGit commitである。rvw独自の「レビュー版」は持たず、ユーザーへ
capture、版番号、版説明、版切り替えを要求しない。

人間はsoftwareを理解し、影響を判断し、次の行動を決める。Agentはauthorizedな実装、test、commit、
push、同期を行う。rvwは両者の間にdurableなreading contextとreview recordを提供するが、Agent
runtimeにはならない。説明上の原則は`docs/product-principles.md`にまとめ、この一次仕様と矛盾する
場合は本書を優先する。

## 2. 絶対に守る境界

rvwが担うもの:

- GitHub PRの取得と最新メタデータcache
- repositoryごとに一件のRepository Review、GitHub default branchとexact sourceの同期・offline cache
- Pull Request / Repository Reviewへ明示登録する同一repositoryのGitHub Issue document
- PR commitのfetch、保持、一覧表示、選択
- 任意の連続commit範囲とPR全体diff
- 最新PRタイトル・本文を表す`Pull Request.md`
- 変更ファイル、repository全体、全文、検索
- PR全体、PR本文、ファイル、コード行へのコメント
- 返信と未解決／解決済み
- commit間の保守的なコメントline mappingとOutdated表示
- `rvw://comment/<uuid>`参照とSkill用CLI
- comment postごとのexact commit固定typed code reference
- 新規comment postのDB-wide event順序、opaque cursor、10秒pollのwatch CLI
- commit固定のAgent Walkthrough、typed code reference、Mermaid図
- platform非依存の`rvw` / `rvw-walkthrough` / `rvw-watch-comments` SkillのCodex / Claude Code向けinstall/status

rvwが担わないもの:

- in-app Ask、AI chat、Agent起動、Agent session管理
- arbitrary branch selector、Repository Review一覧、同一repositoryの複数Repository Review
- Repository ReviewとPull Request Reviewのartifact attach、Issue relation graph、Issue revision履歴
- cross-repository Issue、GitHub Issueの作成・編集・close / reopen
- コード編集、テスト実行、commit、push、PR編集
- GitHub review commentとの双方向同期
- Skillなしで通じる巨大prompt fallback
- PRタイトル・本文のローカル変更履歴
- PR本文の過去diffやcommitとの時点同期
- semantic search、LSP、独自agent loop
- Agentによるbrowser navigation、tab activation、viewer stateの読み書き
- Electron/Tauri、Docker前提、ORM、monorepo

コメント状態は`unresolved` / `resolved`だけとする。Outdatedは保存状態ではなく、
コメントsourceと表示文書から導出する。

## 3. ユーザーが認識する世界

主要概念は次だけである。

```text
Pull Request
Commit
Commit range
Pull Request.md
Repository Review
Issue
Code
Walkthrough
Comment
Unresolved / Resolved
```

Git ref、full source OID、comment target、SQLite IDは必要なprotocol以外で露出させない。

`Pull Request.md`は実装が満たそうとする意図、CommitとCommit rangeは実装が変化した順序、Codeは
選択commitが作るsoftware、diffはそのsoftwareで変更された場所を示す。Commentは人間の理解から
生じた質問、修正要求、確認結果をsoftwareの具体的な位置へ結び、Agentとの次の協業単位になる。
WalkthroughはAgentが説明として提示する読み物であり、事実の正本ではない。人間はinline referenceや
diagram nodeから任意のcodeを開き、説明とcommit済みsourceを自分で照合する。同じ参照を横や下へ
列挙するindexは表示しない。

Repository Reviewのidentityはcanonical GitHub repositoryであり、default branch名が変わっても同じrowを
再利用する。pathから解決するたびに、保存済みGit common directoryと、localの`git remote get-url`から
得たcanonical GitHub repository identityをcase-insensitiveに検証する。remote identityを解決できて異なる
場合は`REPOSITORY_MISMATCH`でfail closedし、GitHub API、fetch、DB更新、location更新、ref作成、Issue同期
より前に停止する。GitHub repositoryのrename / organization transferは自動追従せず、元のbindingで明示
resetして新しいaggregateを作る。default branchのrenameはidentityを変えない。
保存済みGit common directoryと異なるpathでも、canonical identityが一致し、candidate clone内の
`refs/rvw/repository/<repositoryReviewId>/` namespaceが存在し、そのIDのlive DB rowがある場合は、新しい
aggregateを作成しない。canonical identityも一致する場合は通常openを`REPOSITORY_RELOCATION_REQUIRED`で停止し、
`origin`が変更されても別remoteが保存identityと一致すれば同じrelocation境界へ入り、一致remoteがなければ
`REPOSITORY_MISMATCH`でfail closedする。`repository relocate`はlive namespaceのReview IDから保存identityを解決して
全remoteを検索し、
canonical identityに加え、DBが参照するcurrent／historical source OIDの全件について、そのReview IDのexact refと
commit objectをpreviewと実行時に検証する。previewは必須／検証済み件数と欠損明細を返し、review change sequence、
旧／新worktree path、旧／新common directory、source OID、全証跡検証結果を含むconfirmation tokenと`--yes`を
受けた場合だけ保存locationを更新する。source、artifact、retained refは変更しない。全owned refまたはobjectを
持たない独立cloneはrelocation候補にせず、従来どおり`REPOSITORY_MISMATCH`にする。
worktree pathとGit common directoryは保存・比較前にfilesystem `realpath`へ正規化する。新規作成時の複数GitHub remoteは
`origin`、その後remote名順で選択する。既存Reviewは保存済みcanonical identityに一致するremoteを同じ順序の全remoteから
検索し、無関係な`origin`だけを理由に拒否しない。実際に選択したname／URLを`repository open`、viewer header、`doctor`で観測可能にする。
`doctor`は現在のGit common directoryにbound Reviewがあれば同じ保存identity基準でremoteを選ぶ。
`doctor`はreview-owned Repository Review refをcurrent、artifact referenced、unreferenced、deleted-review orphanへ分類する
read-only reportを返し、自動削除しない。

sourceはGitHub repository metadataが返したdefault branch OIDを一時refへfetchして一致を検証し、
`refs/rvw/repository/<repositoryReviewId>/commits/oid-<oid>`へ保持する。checkout、index、worktreeを変更しない。
metadata取得後、fetchしたdefault branch tipが進んでいた場合は`GITHUB_REPOSITORY_ERROR`のremote snapshot
競合としてmetadataとOIDを一度だけ再取得し、`LOCAL_STATE_INCONSISTENT`としてresetを案内しない。
Repository Review document、Comment、Walkthrough、typed referenceが受理するsource OIDは、そのRepository Review IDの
namespaceにあるcurrentまたは既存retained refと同じOIDに限り、clone内や別Repository Review namespaceに
存在するだけのcommitは認めない。保存済みGit common directoryとreview-owned current source refはlocal
bindingの証明とする。同じcommon directoryの別worktreeは同じreviewを利用できるが、canonical repositoryが
同じ独立cloneや保存pathを置換した別repositoryは同期・削除前に明示errorとし、path、common directory、
source、ref、artifactを変更しない。別cloneでの再作成は登録済みreviewの明示reset後だけ許可する。

local remote identityが一致し、GitHub networkだけが失敗した場合は、一度保持したsource、Issue、Comment、
Walkthroughをcacheから読める。remoteを解決できない場合も、同じGit common directoryとreview-owned source
refおよびGit objectが一致するcached read、comment discovery、Issue removal、resetというlocal operationは
許可する。`repository open`のcache hitだけは現在の同一common-directory worktreeへ`localRepositoryPath`を更新する。
existing-only previewは実際のGit readに現在pathを使うが、locationとsequenceを更新しない。GitHub同期と
Issue追加は拒否する。同期はIssueごとの結果と失敗分離を維持しつつ最大8件を並列取得し、一件の
取得失敗で他のcached文書を失わない。同じGitHub client processでは成功した認証確認を共有する。

Issue cacheはcanonical GitHub identityで共有し、review membershipは別tableで所有する。PR本文からは
同一repositoryの直接参照だけを一段抽出し、Walkthrough payloadの`issuesToAdd`は追加だけを保証する。
`issuesToAdd`は一操作50件、各参照256文字を上限とし、Repository Reviewではcanonical remoteを検証する
remote mutationとして扱ってからIssueを取得する。Issue
参照抽出はMarkdownのproseとlink destinationだけを対象にし、inline/fenced codeとraw HTML内の見かけ上の
参照を登録しない。Issue本文やWalkthroughから再帰探索せず、参照消失でもmembershipを自動削除しない。Issue本文hashが変わった
場合、旧本文range Commentは保守的にOutdatedとし、自動resolveしない。membershipを明示削除した場合は、
そのIssue文書と削除されるthreadのpage内draftだけを破棄し、別文書のdraftは保持する。
GitHub Issue responseはclientで`html_url`のowner／repository／numberとresponse numberをrequestへ照合し、
差し替え可能なGitHub portに対してapplication層でも返却identity、canonical name、URLを再検証する。
case-insensitiveな同一identityだけを許し、不一致は`GITHUB_ISSUE_ERROR`としてcache、membership、sequenceを
変更せずfail closedする。repository rename／transferへは自動追従しない。
共有cacheのcontent versionはGitHub `updatedAt`とする。古いresponseは書き込まず、同一versionでtitle、body、
stateが異なるresponseはcorruptionとして`GITHUB_ISSUE_ERROR`にする。同期失敗は共有content rowではなく、
同期を実行した`pull_request_issues`または`repository_review_issues`の`sync_error`へ保存する。fetch開始時に読んだ
内部`cache_generation`がtransaction内でも同じ場合だけerrorを書き、新しい成功後の古い失敗はskipする。
accepted successは同一millisecondでもgenerationを必ず増やし、`fetchedAt`をCAS tokenとして使用しない。
最後のmembership削除またはresetはownerのなくなった`github_issues` rowを同じtransactionでGCする。ほかの
Reviewが所有していてGCできない同一version conflictは、明示`issue refresh --force`がidentityと二回連続の
一致snapshotを確認し、取得開始前のcache generationがまだcurrentな場合だけ共有cacheを再構築する。

### 3.1 Commit選択

- 一件または連続する複数commitを一つの範囲として選ぶ。latest側commitのrepository全体を表示できる。
- diffは`oldOid -> newOid`の二点で表す。
- 一件または複数選択のearliest側がcurrent PR commit列の先頭なら、
  `comparison_base_oid`からlatest側commitまでを表示する。それ以外はearliest側commitのfirst parentを
  old側にし、選択commitを両端を含めて表示する。
- `PR全体`shortcutはcurrent PR commit列をすべて選択し、`comparison_base_oid`からlatest headまでを表示する。
- current baseを取り込んだmerge-back commitはmerge base更新後のcurrent PR commit列で先頭になるため、
  first parentではなく`comparison_base_oid`をold側にする。列の中間に残るmerge commitはcurrent baseに
  含まれない変更を取り込んでいるため、通常どおりfirst parentをold側にする。
- UIへ変更前の境界commitを露出せず、利用者は差分へ含めるcommitだけを選ぶ。
- current PR commit列にないforce-push前のsource OIDは通常selectorへ混ぜない。
  古いコメントからexact sourceを開くことはできる。

### 3.2 Pull Request.md

`Pull Request.md`はGit tree外のvirtual documentである。

```markdown
# <latest PR title>

<latest PR body>
```

- LFへ正規化する。
- 常に最後に成功したGitHub同期のtitle/bodyだけを表示する。
- commit selectorを切り替えても内容は変わらない。
- full viewだけを持ち、PR全体diffやcommit range diffは持たない。
- 過去本文が必要な場合はGitHubのedit historyへ委ねる。
- document identityは`pullRequestId`だが、rendererとcomment placementのcacheは本文revisionを区別する。
  title/bodyだけが変わった同期でも本文、inline comment位置、Outdated表示を同時に更新する。

## 4. Git / GitHubの意味論

### 4.1 GitHub取得

GitHub CLIの既存認証を使用する。独自OAuthを持たない。

```bash
gh pr view <PR> --json \
  author,number,url,title,body,updatedAt,state,isDraft,\
  baseRefName,baseRefOid,headRefName,headRefOid,\
  headRepository,headRepositoryOwner
```

Phase 1の新規登録とsyncは`github.com`のopen/draft PRを対象とする。保存済みPRの
ローカル表示はPRの現在状態やnetwork接続に依存しない。

### 4.2 Local-first open

`rvw open`は同じGit common directoryに保存済みのPRを解決できる場合、SQLiteと
保持済みGit objectだけでviewerを起動する。GitHub更新はviewer表示を妨げない別操作とし、
UIは起動後に更新を試み、失敗時もcacheを表示し続ける。

保存済みPRの完全URL、または全登録PRで一意な番号を明示した場合は、cwdがrepository外でも保存済み
`local_repository_path`を使ってviewerを起動できる。保存先だけを変える場合は
`rvw pr attach <PR> --repository <path>`を使い、viewerを起動しない。

未登録PR、URLを省略して現在branchから初めてPRを解決する場合はGitHub接続が必要。

### 4.3 Object取得と保持

不足objectはbase repository URLから操作固有の一時refへfetchし、GitHubのOIDと一致を
検証する。`FETCH_HEAD`を共有状態にしない。一時refは成功・失敗にかかわらず削除する。

各同期でPR headを次のimmutable refへ保持する。

```text
refs/rvw/pr/<number>/commits/oid-<head-oid>
```

`oid-` prefixは40桁hexだけのref path componentをGitが拒否するために付ける。ref名のOIDと
ref valueは一致しなければならない。head refがそのancestorを保持するため、
comparison base用の別refは作らない。force-push後も旧head refを削除せず、旧コメントの
source objectを保持する。

### 4.4 Comparison base

同期時に次を計算し、`pull_requests.latest_comparison_base_oid`へ保存する。

```bash
git merge-base <latest-base-tip-oid> <latest-head-oid>
```

現在の`PR全体`はこのOIDをold側にする。過去時点のbase tipやcomparison base履歴は持たない。

### 4.5 Commit一覧

current PR commit一覧は`latest_comparison_base_oid..latest_head_oid`から`--ancestry-path`を使って
Gitのtopological historyを取得する。custom rangeの開始候補はdestinationより前のcurrent PR
ancestorだけに絞り、既定値は最も近い先行commitとする。
最低限次を返す。

```typescript
interface CommitSummary {
  oid: string;
  parentOids: string[];
  subject: string;
  authorName: string;
  authoredAt: string;
}
```

commit rowをSQLiteへ複製しない。message、author、time、parentはGit objectから読む。

## 5. 文書モデル

```typescript
type DocumentRef =
  | { kind: "pull-request-markdown"; pullRequestId: string }
  | { kind: "issue-markdown"; pullRequestId: string; issueId: string }
  | { kind: "repository-file"; pullRequestId: string; sourceOid: string; path: string };

type RepositoryReviewDocumentRef =
  | { kind: "issue-markdown"; repositoryReviewId: string; issueId: string }
  | { kind: "repository-file"; repositoryReviewId: string; sourceOid: string; path: string };

type ReviewDocumentRef = DocumentRef | RepositoryReviewDocumentRef;

type DiffDocumentRef = {
  kind: "diff";
  old: DocumentRef | null;
  new: DocumentRef | null;
};
```

repository documentはreview kind、review ID、`sourceOid + path`がexact snapshotである。PR本文は
latest-onlyなので`pullRequestId`、Issue本文は共有cacheを参照しつつ`review kind + review ID + issueId`が
viewer上のidentityになる。

文書navigationは「変更箇所を確認して終了する」ためではなく、変更から周辺実装へ辿って結果を
理解するためにある。changed filesは出発点、all filesとsearchは関連contextの発見、full viewは
結果として存在するsoftwareの読解、changes viewは選択commit範囲の編集箇所を重ねるlensを担う。
変更されていないrepository fileも同じDocumentRefとcomment対象を持つ。

### 5.1 表示

- full: 選択範囲のlatest側commit OIDの全文
- changes: 選択した連続commit範囲がcurrent PR commit列の先頭から始まる場合は
  `comparison_base_oid`、それ以外はearliest側commitのfirst parentからlatest側commit OID
- changed files: `git diff --name-status -z --find-renames <old> <new>`
- all files: `git ls-tree`でdestination tree全体
- code search: `git grep -z -n -I -F`へcase-insensitiveの`-i`とwhole-wordの`-w`を選択的に
  追加し、destination OIDへ実行
- PR本文検索: latest `Pull Request.md`だけ

UTF-8 textだけを通常表示し、CRLFはLFへ正規化する。binary、1 MiB超、symlink、submodule、
empty fileは従来どおり明示的に扱う。

### 5.2 Viewer navigation

- 連続commit range picker、全文／変更、diff styleは最上部top bar内へ置く。range pickerは
  subject、short SHA、commit日時、選択件数を表示する。PR全commitを選択中なら`PR全体`、それ以外でlatest headが
  選択範囲のlatest側なら`最新`を明示する。
- range picker内はclickで一件、pointer dragまたはShift+clickで両端を含む連続範囲を選択する。
  `PR全体`と`最新だけ`のshortcutも提供し、範囲内のcommitを一件ずつtoggleさせない。
- 開いた`Pull Request.md`とrepository fileはpaneごとにpath identityで重複しない一時tabとして保持する。
  同じdocument identityは左paneと右paneへ一つずつまで開ける。
- `Cmd` / `Ctrl`+`P`は全repository fileと`Pull Request.md`を対象にQuick Openを開く。file名を
  pathより優先するbrowser内fuzzy search、match highlight、open / active状態、file / change iconを表示し、
  Arrow keyで選択、Enterまたは通常clickで左pane、`Cmd` / `Ctrl`+clickで右paneへ追加して開き、
  Escapeで閉じる。
- Walkthroughも独立した一時tabとして保持し、そこからcodeを開いても説明tabを閉じない。
  tabは個別に閉じられ、paneの`...` menuからactive以外またはpane内すべてを一括で閉じられる。
  overflow時は横scrollとopen-tab一覧を提供する。
- browser Back / Forwardは、操作順にfocused paneのactive文書と行またはpane内scroll位置を辿るreading
  historyとして扱う。file tree、Quick Open、tab、Search result、comment target、Walkthrough reference、
  repository Markdown linkと同一Markdown内の見出しlinkによる文書または行への移動だけを新しいentryにし、
  単なるpane focus、tab close／move、pane幅、sidebar、検索入力、自動syncをentryにしない。commit範囲、
  全文／変更、stacked / split、
  tree modeはhistoryから復元せず、Back / Forward後も現在のglobal review scopeを維持する。
- history復元では記録したpaneに対象文書が開いていればそのcopyを優先し、一方のpaneだけに開いている場合は
  そのpaneを使う。閉じている場合だけ記録したpaneへ再度開く。対象paneを
  focusして文書と位置を復元するが、もう一方のpane、open tab集合、pane配置を巻き戻さず、移動元のtabも
  閉じない。line navigationは適用位置に留まる間だけline anchorを保持し、利用者がそこからscrollした後は
  実際のpane内scroll位置へ切り替える。pane内scrollはbrowserのwindow scroll restorationへ委ねず、文書
  ごとの位置として復元する。reloadは既存の一時workspace境界を保ち、保持された現在entryを初期文書で置換する。
- document workspaceは通常一ペイン、必要時に横並びの最大二ペインとする。同じdocument identityは各paneに
  一つまで所属でき、tab drag & dropまたはpane headerの`...` menuで左右へ移動できる。移動先に同じidentityが
  すでにある場合は移動先の一つへ統合する。未送信の新規comment draftとinline reply draftは、明示的なtab移動、
  最後の左tabを閉じた時の右から左への正規化、外部削除後のreconcileを問わずdocumentとともに移動する。
  移動先の同じcomposerまたはthreadに別draftがある場合は本文を暗黙に統合または上書きせず、workspace変更を
  明示的に拒否する。
- sidebarとdocument workspaceの境界、および二ペイン間の境界はpointer dragで横幅を変更できる。
  sidebarはmain reading surfaceの最低幅を残し、各document paneも最低幅を持つ。dividerのdouble clickは
  既定幅へ戻し、左右arrow keyでも調整できる。幅はbrowser内だけの一時状態で永続化しない。
- sidebarのfile、search result、Issue、Walkthrough、comment targetと、document pane内のWalkthrough reference、
  diagram node、repository Markdown link、comment内referenceは、通常clickで左pane、`Cmd` / `Ctrl`+clickで右paneへ
  開く。操作元やfocused paneは文書を開く先へ影響させない。tab clickはそのtabが属するpaneをactivateし、
  同一Markdown内の見出しlinkは表示中pane内を移動する。新しい右paneを初めて作る場合も、code
  referenceの選択範囲を描画完了後にviewport中央へfocusする。
- Walkthrough reference、repository Markdownの相対link、comment targetを開いても、repository全体の
  commit範囲、全文／変更、stacked / split、tree modeを変更しない。Walkthrough referenceは全文では
  retained exact source、変更では現在選択中のcommit範囲を同じpathへ適用し、stacked / splitを
  切り替えられる。repository Markdownの相対linkとcomment targetはglobal表示が変更でも、そのpaneだけ
  retained exact sourceの全文を表示する。参照元と対象commitが異なる場合は両方のshort SHAを控えめに
  明示する。Walkthrough referenceのexact sourceを取得できない場合はtabやpaneを開かず、操作元の
  Walkthroughへ一時chipを表示し、リンク切れと一時的な取得失敗を区別する。
- Markdown内の画像はrepository Markdownまたはcomment postから、後述する基準commit内の相対pathを
  参照する場合だけexact commit assetとして自動取得する。PR本文とPull Request / Repository Reviewへ登録した
  Issue本文ではmodernな`https://github.com/user-attachments/assets/<uuid>`だけをreview scopeの
  localhost endpointへ書き換えて取得する。
  それ以外の外部URL、protocol-relative URL、`data:`、`blob:`、Walkthrough本文、repository pathへ
  安全に解決できない参照はrequestを送らずplaceholderを表示する。画像load errorもalt/titleを保った
  placeholderへ戻す。SVG asset responseは同一originへの直接navigationも含め、scriptと外部subresourceを
  禁止するContent Security Policyとsandboxを付ける。
- Pull Request ReviewとRepository Reviewは同じsidebar、document tab、最大二pane、resize、theme、comment操作を
  使い、review種別だけを理由に別のinteractionや簡易rendererを持たない。Repository ReviewではPR固有のcommit
  range、changes / diff style、`Pull Request.md`だけを表示しない。
- sidebarのtop-level stackはExplorerとCommentsの二つにする。Explorerには、Pull Request Reviewだけの
  `Pull Request.md`、collapsibleなIssues folder、collapsibleなWalkthrough folder、file名filter、repository
  treeをこの順に置き、review文書を同じtreeの並列nodeとして扱う。Issues folder右端の`+` actionでのみ
  Issue追加formを開き、追加成功またはEscapeで閉じる。Issue row右端の削除actionは文書を開くactionから
  分離する。
  Pull Request Reviewではunchanged file表示checkboxを置き、Repository Reviewではrepository tree全体を
  常に表示する。
  本文検索はExplorer headerのactionでSearch viewへ切り替える。ExplorerとSearchは別々のscroll領域へ
  mountしたまま片方だけを表示し、directory、Walkthrough、検索結果の展開状態とscroll位置を保持する。
- tab列は文書navigationだけに使い、review scopeを置かない。review scopeとstacked / splitは
  tabごとに保存しない。
- changed-files tree、tabのchange icon、中央viewerはtop barで選択した同じcommit範囲を使用する。
  sidebar内に別のcomparison selectorを持たない。
- 選択比較で対象fileに変更がなければglobal controlを変えず、そのfileだけdestination commitの
  full textへfallbackして`差分なし · 全文表示`を明示する。`Pull Request.md`とIssue本文も常にfullへ
  fallbackする。Issue本文はPR本文とrepository Markdownが使うSource / Preview viewer、safe rendering、
  source line mapping、inline comment表示を共有する。本文選択からrange commentを作成でき、Issue全体の
  composerは常設せずviewer右上のcomment iconから開く。
- review metadata、Issue一覧、文書、annotation、comment placement、Walkthrough、検索、treeのquery keyは
  Pull Request / Repository Reviewで共通helperから構成し、Issue keyにもreview kindを含める。各reviewの
  `review_change_sequence`更新は共通DocumentViewerが
  実際に読むqueryをinvalidateする。Issue documentのcomponent identityはreview kind、review ID、Issue IDとし、
  Repository Review source OIDを含めない。repository documentだけはpathとsource policy / exact OIDをidentityへ含める。
- Walkthroughのreview scope keyは`["walkthrough", kind, reviewId]`とし、外部更新pollではこのprefixを
  invalidateしてsummary/listと開いているdetailを同時に再取得する。detail更新でpaneをremountせず、左右の
  同一Walkthrough、本文、reference、diagram bindingを揃え、無関係なdraft、focus、pane、scrollを保持する。
- Issue range composerは同一本文のquery refresh中もopen状態、本文、selection、focus、pane、documentを保持する。
  draftは対象body hashを保存し、本文hashが変わった場合は本文とplacementを最新化しつつdraftを残す。古い
  rangeの送信は拒否し、現在本文での明示的な再選択後だけ許可する。semantic range migrationは行わない。
  保存済みのIssue全体コメントはstable Issue identityを対象にするため本文更新後もcurrent、rangeコメントだけは
  作成時body hashと異なればOutdatedとする。
- Repository Reviewのcurrent repository file draftはpaneとpathをstable scopeとし、source OIDは
  `documentRevision`として別に保持する。source同期後もcomposerと本文を復元するが、旧revisionの行選択は送信不可として
  現在sourceでの再選択を要求する。`exact-source` fileはOIDをdraft scopeへ含め、同じpathのcurrent / exact-sourceを
  置換すると入力中の新規commentまたはinline reply draftが非表示になる場合は、同一pane置換だけでなくcross-pane移動後の
  pane正規化も含めてworkspace変更を明示的に拒否する。元documentと同じidentityが別paneに残っていても、draftを所有するpaneの
  tab slotが別identityへ置換される場合は自動移送せず拒否する。file tree、Search、Comment、Walkthrough reference、
  browser history復元を含む全document open経路は同じdraft-aware workspace transitionを通す。拒否時はreading history、
  line navigation、pane内scroll位置を変更せず、受理時だけ移動元のreading historyを保存してからworkspaceをcommitする。
- commit範囲切り替え時はopen pathとglobal表示modeを保ち、latest側commitが変わった場合だけ文書を
  そのcommitへ結び直す。exact source commentから開いた文書は
  通常の選択commit文書へ結び直す。current PR commit列外のexact sourceを開く場合はfull viewだけにする。
- app shellはviewportを上限とし、Explorerのfile／Search view、Comments本文、中央viewerを独立してscroll
  させる。viewportが足りない場合もExplorerとCommentsの両見出しを下端まで常に表示する。Commentsは初期状態を
  collapsedとし、明示操作またはcomment target navigationだけで開く。browser tabのclose、reload、navigationは
  `beforeunload`で標準確認を出すが、in-app tab closeは確認しない。
- top barのPR titleはGitHubのPR pageを別tabで開くlinkとする。その他menuではUI themeを
  light / dark / systemから選べる。選択はOS user data directoryの共通DBへ保存し、異なるPRや
  自動割り当てportで新しく起動したviewerにも引き継ぐ。browser storageは初期表示用cacheに限る。
  systemはOS設定へ追従する。
- Pull Request / Repository Reviewのその他menuからbrowser origin（portを含む）単位でAgentコメント通知を
  明示的に有効化できる。初回のcomment読込は通知せず、以後に追加または編集されたpostのうち、最終変更経路が
  `agent`のものを対象とする。`authorLabel`は任意の表示名であり通知可否には使わず、空、`You`、`Unknown`なら
  通知上は`Agent`と表示する。`🔎 確認中です…`は通知せず、watcherが同じpostを最終回答へ編集した時に通知する。
  通知permissionと設定が有効な場合だけBrowser Notificationを作り、review kind、review ID、post IDをtagへ含め、
  クリック時はviewerをfocusする。

### 5.3 File tree、検索、diff rendering

- `変更ファイル`と`全ファイル`を切り替えられる。directoryは階層表示し、開閉状態を視覚化し、全directoryを
  一括で展開／折りたたみできる。`全ファイル`へ切り替えた時は既定で折りたたみ、中央でrepository fileを
  選択中の場合だけそのfileへ至るdirectoryを展開する。
- `全ファイル`でも選択比較のchange iconを表示する。destination treeから消えたdeleted pathは
  deleted icon付きでtreeへ併記する。
- changed treeとtabにはadded、deleted、modified、renamed、type-changedを可能な範囲で表示する。
- file tree、search result、document tab、viewer headerのfile iconは`@pierre/vscode-icons`の
  Complete tier相当を共通resolverで適用する。filenameをextensionより優先し、unknown extension、
  symlink、submoduleには明示fallbackを持つ。folderも同icon setへ統一する。
- file名filterはbrowser内のfuzzy searchとし、repository本文検索とは分ける。
- 本文検索は選択destination OIDのGit objectだけを`git grep -z -n -I -F`で検索し、worktreeや
  indexの未commit内容を混ぜない。queryは1 KiB、結果は500件、stdoutは8 MiBを上限とする。
- `Pull Request.md`も最新本文だけをfixed-string検索対象に含める。
- 本文検索はExplorer内のSearch viewに置き、正規表現は提供しない。case-insensitiveと部分一致を既定にし、
  case-sensitiveとwhole-wordを明示toggleできる。入力は250 ms debounceで自動反映し、submit buttonを
  持たない。`Cmd+Shift+F` / `Ctrl+Shift+F`はSearch stackを開いて入力欄へfocusする。
- 結果はfile単位で折りたたみ、一致した行と全一致箇所のhighlightを表示する。各fileにはfile treeと
  同じchange iconを表示する。同じ行の複数一致は一行へまとめ、file badgeと全体件数は一致箇所数を
  数える。全file groupの展開／折りたたみを一つのiconで切り替えられる。
- 検索結果を開いてもglobalなfull / changesとstacked / splitを変更しない。fullでは対象行へscrollし、
  changesで未変更contextが閉じていれば対象行まで展開してscrollする。fileに差分がない場合だけ
  通常の`差分なし · 全文表示`fallbackを使う。開いた対象行は次のnavigationまで強調する。
- code/diffは`@pierre/diffs`を使い、syntax highlight、stacked/split、追加・削除数、path、
  file-level comment action、line/range selectionを提供する。コード本文はbrowser標準の文字列選択と
  copyを維持し、line/range comment selectionはline numberとgutter actionから開始する。file headerは
  paneのscroll中もtab列直下へsticky表示する。
- diffのline selectionはold/new sideを明示し、両sideをまたぐ一つのcommentを作成しない。
- UTF-8以外、1 MiB超、symlink、submodule、missing documentは空本文へsilent fallbackせず、
  理由を明示する。empty UTF-8 fileは有効な文書として扱う。
- repository内の`.md` / `.markdown`と`Pull Request.md`は全文表示でPreviewを既定とし、Source / Previewを切り替えられる。
  差分が存在する変更表示ではPreview設定にかかわらず通常のdiffを表示し、Source / Preview切り替えは表示しない。
  差分のない文書と`Pull Request.md`は、既存の全文fallbackに従う。
  Previewは同じexact document textをsafe Markdownとしてrenderし、raw HTMLをallowlistでsanitizeして
  scriptを実行しない。
  GitHubと同様に安全な`details` / `summary`は折りたたみとしてrenderする。tableはcellごとの読みやすい
  最大幅で本文を折り返し、列数が多い場合の横scrollは維持する。
  `Pull Request.md`の本文はGitHubのPull Request本文と同じくsoft line breakを表示上の改行として
  renderする。repository内の`.md` / `.markdown`はGitHubのfile previewと同じくsoft line breakを
  hard breakへ変換しない。
  repository内への相対linkは表示中のfile pathから解決し、同じexact source commitのdocumentとして
  通常clickは左pane、`Cmd` / `Ctrl`+clickは右paneへ開く。外部URLだけをbrowserの別tabで開き、
  fragment-only linkは表示中document内のnavigationとして残す。相対linkを開いてもglobalなcommit範囲、
  full / changes、stacked / split、tree modeは変更せず、対象paneだけexact sourceの全文を表示する。
  Previewのrender treeにはMarkdown parserが持つsource positionを付与し、browser標準の文字列選択を
  inclusiveなMarkdown source line rangeへ変換する。選択境界では最小のsource leafを優先し、子要素の
  単行選択を親blockの複数行へ広げない。table cellとWalkthroughを含むPreview本文はbrowser標準操作で
  文字選択できる。選択後は範囲の近くにcomment actionを表示し、composerは対象block直後の通常flowへ
  React-ownedのdeclarative slotへ挿入して折り返された本文へ重ねない。list/tableでは有効なsiblingに置く。
  line commentをrender済み本文へinline表示する。DOM path、
  layout上の行、生成HTMLはtargetへ保存しない。
  line commentはSourceのgutter/range selectionとPreviewの文字列選択、file commentは両表示から作成できる。

### 5.3.1 画像assetとrepository画像viewer

- GitHub user attachment URLは`https:`、exact `github.com`、空のusername/password/port/query/fragment、
  exact `/user-attachments/assets/<uuid>` pathを共通validatorで検証し、parse後のcanonical URLだけを使う。
  `user-images.githubusercontent.com`と`private-user-images.githubusercontent.com`は安全な認証取得経路を
  確認していないため対象外とする。
- PR本文とPull Request / Repository Reviewへ登録したIssue本文のmodern GitHub user attachmentを表示対象とする。
  browserはGitHub attachment hostへ直接接続せず、対象reviewにscopeしたsame-origin GET endpointを使う。
  endpointは`Sec-Fetch-Site`がある場合に`same-origin`または`none`だけを受理し、`Origin`がある場合は
  viewer originとの一致も検証する。serverは対象Pull Request ReviewまたはRepository Reviewの存在を確認してから、shellを使わない
  `gh api <canonical-url>` argument配列でbinaryを取得する。tokenを抽出、保存、header化せず、認証と
  cross-host redirect処理はGitHub CLIへ委ねる。timeoutは30秒、stdoutは10 MiB、stderrは64 KiBを上限とし、
  process errorのstderrやprivate URLをresponseへ含めない。binaryはSQLiteやpersistent cacheへ保存しない。
- attachmentとrepository assetはbyte列からPNG、JPEG、GIF87a/GIF89a、WebP、AVIFをmagic byteで判定する。
  SVGはUTF-8、任意のBOM/先頭空白/XML declarationと安全なXML commentの後に`svg` rootがある場合だけ許可する。
  doctype、HTML、JSON、任意XML、truncated headerは画像として返さない。responseは検出したimage Content-Type、
  `nosniff`、`Content-Disposition: inline`、`Cross-Origin-Resource-Policy: same-origin`、private immutable cache
  headerを持ち、SVGにはsandbox CSPも付ける。
- repository画像fileは`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.avif`、`.svg`をcase-insensitiveに
  判定し、5 MiB以下のexact commit asset endpointだけで取得する。全文表示は選択sourceのnatural-size画像を
  container内へ縮小し、変更表示はglobalなstacked/split設定にかかわらずold/new二列の単純Splitとする。
  added/deletedは存在しない側を明示し、renameは両pathを表示する。画像・非画像間の変更も画像viewerで両側を
  明示するが、old/new両方の`DocumentRef`を保持して非画像側を含むfile-level comment targetを失わない。
  全文表示へ切り替えたときactive pathが非画像なら通常のdocument viewerへ戻す。
- 画像viewerはtext document/diff APIを呼ばず、表示前のsame-origin HEADで404、413、415を区別した後に
  browser image GETを行う。file-level commentだけを許可し、変更後が存在すればnew side、削除だけはold sideへ
  exact source targetを保存する。既存commentはtargetと一致するold/new側へ表示する。
- extensionless repository画像、zoom/pan、pixel diff、画像座標commentはPhase 1の対象外とする。

#### Private review release前manual smoke

private attachmentをCI fixtureへ保存しないため、release前に次を人間が実施する。

1. private repositoryを閲覧できるaccountで`gh auth status --hostname github.com`が成功することを確認する。
2. そのrepositoryのopen PR本文または登録対象Issue本文へ小さなPNGまたはJPEGをpasteし、生成されたmodern
   `https://github.com/user-attachments/assets/<uuid>` URLを本文に残す。比較用に任意の外部画像URLも一件置く。
3. 対象のPull Request ReviewまたはRepository Reviewをviewerで開き、PR本文またはIssue本文のPreviewでprivate
   attachmentが表示され、外部画像はalt/title付きplaceholderのままであることを確認する。
4. browser DevToolsのNetworkで、表示画像の`src`とrequest先がlocalhostの
   `/api/pull-requests/:id/github-attachment`または`/api/repository-reviews/:id/github-attachment`であり、browserから
   `github.com/user-attachments`や外部画像hostへ直接requestしていないことを確認する。
5. localhost responseが検出済みのimage Content-Type、`nosniff`、private immutable cache、same-origin CORPを
   持ち、reload後も画像表示とplaceholderが維持されることを確認する。
6. private attachment URL、response body、DevTools traceをrepository、issue、CI logへ保存せず、実施結果だけを
   release checklistへ記録する。

### 5.4 Agent Walkthrough

Walkthroughは、外部AgentがCLIで登録するcommit固定のMarkdown documentである。rvwは説明を生成せず、
Agentを起動せず、登録時にもbrowserを開いたりactive tabやscroll位置を変更したりしない。

```typescript
interface CodeReference {
  id: string;
  label: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  description: string | null;
}

interface Walkthrough {
  id: string;
  sourceOid: string;
  title: string;
  body: string;
  authorLabel: string | null;
  diagramBindings: Record<string, string>; // Mermaid node ID -> reference ID
  references: CodeReference[];
}
```

- `sourceOid`は対象PRで利用可能なcommitであり、全referenceはその一つのsnapshotへ固定する。
- publish成功前に`refs/rvw/pr/<number>/commits/oid-<sourceOid>`でobjectを保持する。
- 登録時に各pathがそのcommitで読めるUTF-8 documentであることを検証する。`startLine`と`endLine`は
  両方指定したinclusiveな単行／複数行range、または両方`null`のfile-level referenceとする。
  CLI入力で両方を省略した場合は`null`へ正規化する。line rangeがある場合は文書内に収まることも検証する。
- Markdown内のlink destinationとしてparseされた`rvw-ref:<referenceId>`を登録時に完全一致で検証し、
  typed reference buttonとして表示する。code blockやinline code内の文字列はlinkとして扱わない。
- 全reference IDはMarkdown内の`rvw-ref:` linkまたは`diagramBindings`のvalueとして最低一度使う。
  binding keyは本文中のflowchart nodeまたはclass diagram classとして実在することも検証する。存在しない
  nodeへのbindingを含め、どちらからも実際に到達できないreferenceは、重複indexのないviewerでは
  開けないため登録を拒否する。
- sidebar一覧はtitle、current source OID、author、reference件数だけを返し、現在の本文・参照・diagram
  bindingは人間がWalkthrough tabを開いた時に取得する。CLI更新をpollで検出した場合は、開いているtabも
  同じIDの最新内容とtitleへ結び直す。Explorerの一行表示はtitleを主表示とし、authorと短縮source OIDは
  native tooltipで確認できるようにする。
- Walkthrough tabは本文中のtyped inline referenceとbinding済みMermaid nodeを維持するが、横または下に
  全referenceを重複表示する`Code references` indexは持たない。sidebar itemにもreference件数を表示しない。
- `language-mermaid` code blockはstrict security設定でSVG化する。bundled Mermaidが扱うflowchart、
  class、sequence、state、ERなどの記法を描画対象とする。binding済み要素だけを人間が選べる。
  Phase 1のinteractive bindingはflowchart nodeとclass diagram classをE2E保証し、記法固有のSVG構造を
  持つ他のdiagramは描画対応とbinding対応を分ける。binding済み要素はdiagram種別にかかわらずaccent枠、
  薄いaccent背景、hover / focus強調を共通のaffordanceとして表示する。
- 人間がreferenceを選んだ時だけ、そのexact `sourceOid + path`を事前確認してdocument workspaceへ開く。
  このnavigationはglobalなcommit範囲と表示controlを変更しない。exact sourceのcommitまたはpathが
  missingならtabを開かず一時chipでリンク切れを示し、通信や一時的な取得失敗はリンク切れと区別する。
  line rangeがある場合は範囲全体を強調し、file-level referenceでは行を選択しない。
- 説明本文やdiagramはAgentのclaimであり、code referenceとGit objectが検証可能な根拠である。
- 人間はstableなWalkthrough IDへ文書全体コメントを作成できるほか、render済みMarkdownの文字列を選択して
  parser由来のsource line rangeへコメントできる。Mermaidは生成SVG要素ではなく、元のfenced code block
  全体を一つのsource rangeとして扱い、図全体へのcomment actionを表示する。
  コメントをAgentがCLIで読む場合は、対象Walkthroughの現在本文・参照一覧も同じ応答へ含める。
- AgentはCLIでcurrent Walkthroughを読み、title、本文、`sourceOid`、全reference、diagram bindingを同じIDの
  まま完全置換できる。過去本文、過去reference set、更新revision、version selectorは持たない。
- 更新後も全コメントと`rvw://walkthrough/<uuid>`は同じIDへ残る。文書全体コメントは常にcurrent本文へ
  結び付き、行コメントはquoted textを現在本文へ一意に再配置できない場合Outdatedになる。`comment get`は
  更新後の現在内容とrvwが導出した配置を返す。commit、path、line、Markdown reference、diagram bindingは
  publishと同じ規則で再検証する。
- 人間はviewerから、Agentは明示authorizationを受けたCLIから、不要なWalkthroughを削除できる。削除前に
  reference、対象comment、postの件数を示し、確認後はそれらを一つのtransactionで削除する。共有され得る
  retained Git commit refは個別削除しない。Repository Review refはそのaggregateのresetまで、PR refは将来の明示的・
  排他的GCまでhistorical evidenceとして保持する。
- raw HTMLやscriptは実行しない。本文は256 KiB、referenceは200件を上限とする。
- Phase 1は作成、閲覧、同一ID更新、確認付き削除を扱い、更新履歴、AI chat、自動navigationは扱わない。

## 6. コメントモデル

コメント対象:

1. PR全体
2. Repository Review全体
3. 登録済みIssue本文全体またはMarkdown source行範囲
4. 最新Pull Request.md全体またはMarkdown source行範囲
5. exact commitのコードファイル全体またはコード行範囲
6. diffのold/newいずれかのexact document
7. stable IDを持つWalkthrough全体またはMarkdown source行範囲

```typescript
type CommentTarget =
  | { kind: "pull-request" }
  | {
      kind: "issue";
      issueId: string;
      issueUrl: string;
      issueNumber: number;
      issueTitle: string;
      sourceDocumentHash: string;
      quotedText: string | null;
      startLine: number | null;
      endLine: number | null;
    }
  | {
      kind: "walkthrough";
      walkthroughId: string;
      walkthroughTitle: string;
      sourceDocumentHash: string | null;
      quotedText: string | null;
      startLine: number | null;
      endLine: number | null;
    }
  | {
      kind: "document";
      documentKind: "pull-request-markdown";
      sourceDocumentHash: string;
      quotedText: string | null;
      startLine: number | null;
      endLine: number | null;
    }
  | {
      kind: "document";
      documentKind: "repository-file";
      sourceOid: string;
      path: string;
      startLine: number | null;
      endLine: number | null;
    };

type RepositoryCommentTarget =
  | { kind: "repository" }
  | Extract<CommentTarget, { kind: "issue" | "walkthrough" }>
  | {
      kind: "document";
      documentKind: "repository-file";
      sourceOid: string;
      path: string;
      startLine: number | null;
      endLine: number | null;
    };
```

`comments.created_head_oid`は作成時のlatest PR headを記録する。repository targetの正本は
target自身の`source_oid`である。

Walkthrough targetの正本はstable Walkthrough IDであり、文書全体またはMarkdown sourceのinclusive line
rangeを持つ。render treeのsource positionは選択をsource rangeへ変換する入力にだけ使い、DOM path、layout、
生成SVG要素は保存しない。行targetは作成時の本文hashとexact quoted textを保持するが、Walkthroughのfull
revisionは保存しない。削除時はそのstable IDを持つ全commentとpostも確認件数に含めて削除する。

### 6.1 PR本文コメント

full revisionは保存しない。コメント作成時にserviceが現在の`Pull Request.md`から次を計算する。

- SHA-256 document hash
- 行選択なら選択範囲のexact text
- file-levelなら`quoted_text = NULL`

表示時:

1. hashがcurrent documentと一致すれば元行番号を使う。
2. file-level commentはcurrent `Pull Request.md`へ表示する。
3. 行commentでhashが違う場合、quoted linesがcurrent文書へ一度だけ出現すればそこへ移す。
4. 見つからない、複数ある、legacy commentにquoteがない場合はOutdated。

### 6.2 Walkthrough comment mapping

1. 文書全体commentはcurrent Walkthroughへ表示し、Outdatedにならない。
2. 行commentのhashがcurrent本文と一致すれば元行番号を使う。
3. hashが違う場合、quoted linesがcurrent本文へ一度だけ出現すればその連続rangeへ移す。
4. 見つからない、複数ある、quoteがない場合はOutdatedとしてsidebarへ残し、作成時のquoteを表示する。
5. Mermaidへのcommentは元のfenced code block全体を同じ規則で配置する。生成SVG nodeはanchorにしない。

### 6.3 Code comment mapping

1. source/destination OIDとpathが同じなら元位置。
2. Git diffからrename/deleteを判定する。
3. source/destination本文をline diffする。
4. 対象行が変更されず、一意かつ連続して対応する場合だけinline表示する。
5. それ以外はOutdatedとしてsidebarに残し、exact sourceを開ける。

PR全体commentとWalkthrough全体commentはOutdatedにならない。

### 6.4 Reply

投稿は64 KiB以下のUTF-8 GFM Markdown sourceで、rootとreplyを編集できる。既存のplain textも同じsource
としてrenderし、soft line breakは表示上の改行へ変換する。raw HTMLはallowlistでsanitizeし、scriptを
実行しない。table、task list、code block、repository内link、repository相対画像、表示専用Mermaidを
扱う。comment本文へsource mappingやMermaid node bindingは持たせないが、post単位でtypedな
`rvw-ref:<referenceId>`を持てる。外部linkだけを
browserの別tabで開き、外部画像は取得しない。

comment code referenceはWalkthroughと同じ`CodeReference` schema、ID/path/line/document検証、inline
buttonを再利用する。各postは一つの`related_commit_oid`と0〜200件のreferenceを所有し、referenceが
ある場合は関連commitを必須とする。全宣言はそのpost本文のMarkdown linkから使われ、全linkは宣言済み
IDへ一致しなければならない。referenceはthread内で継承せず、Mermaid bindingにも使わない。通常clickは
related commitのexact sourceを左paneへ、modifier clickは右paneへ開き、globalなcommit範囲を
変えない。作成・reply・edit成功前に関連commitをimmutable refで保持する。
同梱Skillは、finding、調査結果、実装内容、test結果について具体的なcode上のclaimを投稿するとき、
reviewerがexact evidenceを開く価値があればtyped referenceを既定で付ける。comment target自身が同じ
exact sourceを既に開ける場合は、別のlabel付きrangeにnavigation価値がない限り重複させない。code evidenceが
ない、未commit、terminal error、またはtargetの重複にしかならない場合はreferenceを要求しない。

repository内linkと画像の基準commitは、postの`related_commit_oid`、repository targetの`source_oid`、
Walkthrough targetのcurrent `sourceOid`、`comments.created_head_oid`の順に選ぶ。repository targetでは
target fileのdirectory、それ以外ではrepository rootを相対pathの起点にする。通常clickは左pane、
`Cmd` / `Ctrl`+clickは操作元にかかわらず右paneへexact source全文を開き、
globalなcommit範囲や表示modeを変更しない。replyは任意の`related_commit_oid`を持てる。
Agent batch syncのreplyは同期後のGitHub headへ自動的に関連付ける。
人間はviewerから、明示的に依頼された外部AgentはCLIから、同じtarget validationを通して新しいroot
commentを作成できる。Agent作成commentも通常の未解決threadであり、専用stateや自動resolveを持たない。
CLI作成は一回に一threadとし、batch生成やbrowser navigationを行わない。
resolved済みthreadにもreplyできるが、reply単独ではreopenしない。standalone replyとbatch syncの
replyはいずれも現在stateを維持し、resolve/reopenは明示的な別の状態変更とする。
viewerのthread reply draftはpage内memoryへ保持し、server change sequenceによるcomment再取得や
Markdown Preview再構築でthreadが再mountされても本文と入力focusを復元する。送信成功、thread削除、
review resetでは破棄し、page reloadを越えて永続化しない。同じdocumentを左右に開いた場合はpaneごとに
分離し、workspace変更でdocumentのpaneが変わった場合はdraftも移す。移動先の同じthreadにdraftがあれば
workspace変更を拒否する。新規comment draftも同じpane/document境界と移送規則に従う。
新しいroot postとreplyは同じtransactionでDB-wideな単調増加event sequenceへ記録する。既存postは
migration時にbackfillせず、編集、削除、resolve/reopenはeventを作らない。Agent自身のreplyも通常eventであり、
watch taskが返却post IDで抑止する。
Pull Requestのwatch taskはbatchをclaimし、対象threadの存在を確認した直後に通常replyとして
`🔎 確認中です…`を一件作成する。task-local DBはbatch内のcomment URIごとに冪等keyとstatus post IDを
保持し、同じbatchのretryだけでそのpostを再利用する。同じthreadへの後続replyを別batchで処理するときは
新しいstatus postを作成し、過去の回答を変更しない。調査または作業の完了、terminal failureでは現在の
batchの同じpost本文を一つの最終結果へ編集し、新しい完了replyを追加しない。このstatus postは専用comment
stateではなく通常postであり、threadのunresolved/resolved状態を変えない。Repository Review batchは進捗postを作らず、
完了時に一件のfinal replyだけを追加する。
誤投稿を取り消すため、reply postは個別に物理削除できる。root postの削除はcomment targetと
`rvw://comment/<uuid>`のanchorを含むthread全体の削除として扱い、返信があれば同じtransactionで
すべて削除する。確認画面は返信も削除されることを明示する。編集・削除はchange sequenceを更新する。

### 6.5 Comment navigationとコピー

- sidebarは未解決／解決済みを切り替え、各commentのOutdated状態、全post、常設reply欄を表示する。
- sidebarの各threadには常にcheckboxを置き、選択が一件以上ある場合だけ一括copy actionを表示する。
- Diff内のresolved threadは既定で一行に折りたたみ、展開すればpost、reply欄、reopen actionを表示する。
- 参照copy、post編集、削除は各postの`...` menuへ格納し、resolve/reopenはthread actionとする。
- commentからexact source documentを開ける。force-push前のrepository sourceも保持refから開く。
  このnavigationはglobalなreview scopeを変更せず、対象paneだけcomment時点の全文を表示する。参照元commitが
  対象commitと異なる場合はshort SHAを表示する。
- 一件、表示中の一覧すべて、複数選択したcommentの`rvw://comment/<uuid>`をコピーできる。
- copy textはSkill利用を依頼する短い文とURIだけで構成し、comment本文や巨大promptを埋め込まない。
- どのcomment集合をいつcopyしたかは永続化しない。

## 7. Agent CLI protocol

AgentはSQLiteを直接読まず、必ずJSON CLIを使う。

```bash
rvw protocol --json
rvw pr refresh <PR_REF> --json
rvw pr sync --stdin --json [--repository <PATH>] [--allow-untracked]
rvw pr attach <PR_REF> --repository <PATH> --json
rvw walkthrough get <WALKTHROUGH_URI> --json
rvw walkthrough publish --stdin --json
rvw walkthrough update <WALKTHROUGH_URI> --stdin --json
rvw walkthrough delete <WALKTHROUGH_URI> --json
rvw walkthrough delete <WALKTHROUGH_URI> --yes --confirmation-token <TOKEN> --json
rvw comment create --stdin --json
rvw comment list <PR_REF> --state unresolved --limit 50 --offset 0 --json
rvw comment watch [--after <CURSOR>] [--interval 10] --json-seq
rvw comment get <COMMENT_URI> --json
rvw comment get <COMMENT_URI> --include-pr-body --json
rvw comment get <COMMENT_URI> --live --json
rvw comment reply <COMMENT_URI> --stdin --json
rvw comment edit <COMMENT_URI> --post <POST_ID> --stdin --json
rvw comment resolve <COMMENT_URI> --json
rvw comment reopen <COMMENT_URI> --json
```

current protocol versionは4とし、最初のpublic compatibility contractはversion 1である。公開前に
使用した内部version番号は互換性保証の対象外とする。public release後は番号を再利用せず、breaking
changeのたびに単調増加させる。capabilityは次を含む。

```text
agent.transport
repositoryReview.read
repositoryReview.sync
issue.read
issue.membership
issue.cacheRepair
comment.create
comment.list
comment.watch
comment.read
comment.reply
comment.edit
comment.codeReferences
comment.resolve
comment.reopen
pullRequest.sync
walkthrough.read
walkthrough.publish
walkthrough.update
walkthrough.delete
```

### 7.1 comment create

Agentは、明示的にコメント作成を依頼されたreviewで見つけた指摘を、viewerと同じcomment threadとして
登録できる。

```bash
rvw comment create --stdin --json
```

stdinのrepository line comment例:

```json
{
  "pullRequest": "https://github.com/owner/repo/pull/123",
  "target": {
    "kind": "document",
    "documentKind": "repository-file",
    "sourceOid": "0123456789abcdef0123456789abcdef01234567",
    "path": "src/request-handler.ts",
    "startLine": 18,
    "endLine": 24
  },
  "body": "この分岐では失敗結果が [呼び出し元](rvw-ref:caller) へ返りません。",
  "relatedCommitOid": "0123456789abcdef0123456789abcdef01234567",
  "references": [
    {
      "id": "caller",
      "label": "Request caller",
      "path": "src/request-caller.ts",
      "startLine": 30,
      "endLine": 38,
      "description": null
    }
  ],
  "authorLabel": "Agent name"
}
```

`pullRequest`は登録済みPRの完全URLまたは全登録PRで一意な番号とする。targetは通常のPR全体、最新
`Pull Request.md`全体／行範囲、exact commitのrepository file全体／行範囲、Walkthrough全体／行範囲を
受け付ける。行を省略した入力は`null`へ正規化し、line pair、commit、path、文書availability、
Walkthrough所属、本文byte上限はviewer作成と同じapplication serviceで検証する。
任意の`references`は同じpostの`relatedCommitOid`を必須とし、Walkthroughと共通のschemaでcommit、
UTF-8 document、path、line range、Markdown linkとの完全一致を検証する。参照はpost単位でありthreadへ
共有しない。

成功時は未解決のcommentとroot post、`rvw://comment/<uuid>`を返す。作成は非冪等であり、送信後の結果が
不明な場合は`comment list`で重複を確認してから、未作成の場合だけ再実行する。作成はviewerを開かず、
tab、pane、scroll、commit selectionを変更しない。

### 7.2 pr sync

stdin:

```json
{
  "pullRequest": "https://github.com/owner/repo/pull/123",
  "commentUpdates": [
    {
      "commentRef": "rvw://comment/uuid",
      "reply": "対応内容は [更新箇所](rvw-ref:result) で確認できます。",
      "resolve": false,
      "references": [
        {
          "id": "result",
          "label": "Updated implementation",
          "path": "src/request-handler.ts",
          "startLine": 18,
          "endLine": 24,
          "description": null
        }
      ]
    }
  ]
}
```

前提:

- authorizedな修正、test、commit、push、必要なPR本文更新が完了済み
- 選択したlocal worktreeに未commitのtracked変更がない
- 未追跡fileがある場合は内容を確認して`--allow-untracked`を明示する
- local branchがPR head branchの場合、local固有commitを持たない。GitHub headより単にbehind、または
  force-push前の最終同期済みGitHub history上なら許可する

既定は保存済み`localRepositoryPath`を使う。`--repository <PATH>`は同じGit common directoryのcleanな
worktreeを明示する。dirty errorは判定したpathとstatus entry一覧を返す。同期はGitHub PR headを内部refへ
fetchするが、behindなworktreeのcheckoutやbranch refは変更しない。

処理:

1. GitHub状態取得
2. object取得、comparison base計算
3. immutable head ref作成・検証
4. SQLite transactionでlatest PR cache、reply、resolve、change sequence更新
5. reply referenceをcurrent GitHub headで検証し、replyの`related_commit_oid`へそのheadを設定

`comment create`は非冪等である。`pr sync`と`comment reply`のreplyは任意のidempotency keyを受け、
同じcaller payloadのretryは元のpostを返す。syncが内部で関連付けるGitHub head OIDはcaller payload
fingerprintへ含めない。keyspaceはdatabase全体でPR／Repository Review replyに共通とし、別kindを含む別payloadへの
key reuseは拒否する。元postが削除済みなら再作成せず明示errorにする。

### 7.3 comment watch

`rvw comment watch --json-seq`は保存済みの全Pull Request ReviewとRepository Reviewの新規root commentとreplyをRFC 7464 JSON text
sequenceとして出力する。cursor省略時は現在の最新event位置へanchorし、起動前の既存未解決commentを
処理しない。最初の`ready` frameがdatabase-scoped opaque cursorを返し、その後の`comment-posted` frameは
各event直後のcursor、sequence、post ID、comment URI、削除済みかと、stableな`pullRequestId`または
`repositoryReviewId`、表示用のPR URLまたはcanonical repositoryを持つ明示的なreview contextを返す。
routingとbatch keyにはreview IDだけを使うため、repository casing変更は同じcontext、Repository Review reset後の
再作成は同じrepository表示でも別contextになる。eventは最小triggerとし、Agentは必ず`comment get`でthreadを読み直す。

`--after`は同じdatabaseのcursorから再生し、別database、最新sequenceより先、破損、未知versionのcursorを拒否する。poll間隔は
既定10秒、1〜300秒とする。event rowはcomment/post削除と独立して保持し、削除後の再生は`deleted: true`
として返す。複数の独立taskは別cursorで同じlogを読める。

cursor、pending queue、retry、authorization、Agentが作成したpost IDは外部Agent taskがrepository外へ
保持する。同梱Skillのstate scriptはtask専用SQLiteを使い、event enqueueとcursor更新、batch lease、retry、
batch内のcomment URIごとのstatus post mapping、自己post抑制をtransaction化する。batch claim直後にthreadを
確認する。最初のauto-ack claimはack投稿より前に、表示用Agent名または意図的な無名をtaskのimmutable metaへ
固定する。再開時は同じ値だけを使い、異なる指定はrvwへのread/write前に拒否する。Pull Request batchだけが
冪等なack replyを即時作成し、同じbatchのretryでstatus postがあれば
そのpostをack本文へ戻す。後続replyの新しいbatchは新しいpostを作り、完了時は現在のbatchのpostを最終結果へ
編集する。claim後の全threadが削除済みなら、stable contextの再解決やack、worker委譲を行わずbatchとeventを
completedにして`batch-discarded`を通知し、driverは監視を継続する。一部だけ削除済みなら、残存threadからstable
contextを確定して削除済みoperationも`gone`として同じbatchで処理する。Repository Review batchは常に`investigate-and-reply`でacknowledgementやwrite reservationを作らず、worker
resultの`context.kind = repository`、`repositoryReviewId`、repositoryを使用する。各operationのstable idempotency keyで一つのfinal
replyを投稿し、返されたpost IDをsuppressionとしてdurableに登録してからleaseをcompleteする。eventが
complete前にingest済みならpending rowをcompletedへ移し、後ならingest時にsuppressする。reply後の再起動は
同じkeyで既存postを取得して同じ完了手順を再開する。同梱preflightは
protocol、capability、transport、Nodeを一括検査し、watch driverは
stateのcursorを自動解決してRFC 7464 frameをatomicにingestする。driverのauto-ack modeは新規batchを
LLM往復なしにclaim、thread再読込、ack投稿まで進め、leaseとthread contextを一行JSONで通知する。
親taskは起動前にsubagent slot数を予約する。`max-in-flight`は8を目標とし、runtimeが8枠を保証できれば8、
それ未満なら保証できる最大の正数、複数枠を保証できなければ1を指定し、予約数を超えない。driverはlimit
未満だけauto-ackし、task stateを短周期で再確認する。investigate-and-replyだけを許可したtaskでは、同一PRの
active lease中に到着したeventも別batchとしてcapacity内でauto-ackし、同じPRまたはrepositoryをread-onlyで
並列調査できる。Repository Review batchはtask全体のpolicyにかかわらず常にこのread-only並列規則を使う。batchごとの
status postまたはRepository Review final replyを使うため結果は衝突しない。fix-and-pushを許可したtaskではPull Requestの
後続eventを先行lease解放後まで待たせ、repository write reservationにより異なるPR間のwriterも直列化する。
retryable failureは`nextAttemptAt`到達後に、新しいwatch eventやreconnectを待たずauto-ackする。
state toolはpending集合のemptyからnon-emptyへの遷移を一行JSONで待機できる。rvwはAgentやsubagentを
起動せず、これらのtask stateも保持しない。
task起動時に明示された場合だけ、live PR authorと起動時GitHub loginが一致し、live head repository、branch、
OIDとpush先が一致するPRをfix-and-push候補にできる。他人、不明、不一致はinvestigate-and-replyとする。
親taskはacknowledge済みleaseをbatchの大きさ、mode、変更有無にかかわらず同じscheduling turn内で一つの
fresh subagentへ必ず委譲し、直接調査・実装しない。subagentを速やかに起動できない場合はleaseをretryable
failureへ戻し、親taskが代行しない。subagent結果は、最終bodyに加えて`relatedCommitOid`、完全な
`references`配列、`pushStatus`を持つ。
code変更がない調査結果でも、具体的なcode上の結論を支える利用可能なreview commitとtyped referenceを返せる。
Repository Reviewではcurrent sourceまたは既存retained refのOIDだけを認め、任意のlocal commitを根拠にしない。
parentはthreadを再取得してbody、commit、referenceを検証し、同じstatus postの完全置換へすべて渡す。
fix-and-push後のreferenceは同期済みGitHub headへ固定する。referenceがない結果は空配列を明示し、以前の
retryやacknowledgementから宣言を引き継がない。

### 7.4 Walkthrough lifecycle

既存Walkthroughはstable URIから現在内容と対象review contextを取得できる。

```bash
rvw walkthrough get <WALKTHROUGH_URI> --json
```

#### Publish

Agentは実装・周辺code・architectureの説明を、人間が後から任意に検証できるartifactとして登録する。

```bash
rvw walkthrough publish --stdin --json
```

stdinの最小例:

```json
{
  "pullRequest": "https://github.com/owner/repo/pull/123",
  "sourceOid": "0123456789abcdef0123456789abcdef01234567",
  "title": "Request flow",
  "body": "Start at [the handler](rvw-ref:handler), then inspect the [composition root](rvw-ref:composition).",
  "authorLabel": "Agent name",
  "diagramBindings": { "Handler": "handler" },
  "references": [
    {
      "id": "handler",
      "label": "RequestHandler.execute",
      "path": "src/request-handler.ts",
      "startLine": 10,
      "endLine": 24,
      "description": "Application orchestration boundary"
    },
    {
      "id": "composition",
      "label": "Application composition root",
      "path": "src/application.ts",
      "description": "File-wide dependency wiring"
    }
  ]
}
```

`review`と`sourceOid`、title、body、1件以上のreferenceは必須である。`review`はPull Request URLまたは
Repository Reviewのcanonical repositoryをdiscriminated unionで指定する。CLIはcommit、path、
任意のline range、Markdown reference、実在するflowchart/classDiagram nodeへのdiagram bindingを検証し、本文linkまたはdiagram bindingから
一度も参照されないreferenceを拒否してから、一つのSQLite transactionで保存してchange sequenceを
更新する。成功responseは`walkthrough`へ`rvw://walkthrough/<uuid>`を含むWalkthrough全体、`issuesAdded`へ
同じSQLite transactionでmembershipを実際に追加したIssueだけを返す。追加がなくても空配列を返し、
direct database fallbackとAgent socketでJSON serialize後のschemaを一致させる。
このcommandはbrowserを開かず、どのviewerのnavigationも変更しない。

#### Update

```bash
rvw walkthrough update <WALKTHROUGH_URI> --stdin --json
```

stdinはpublish inputから`review`を除いた完全置換objectであり、`sourceOid`、title、body、全referenceを
必須とする。`diagramBindings`省略時は空、`authorLabel`省略時だけ既存値を保つ。publishと同じ検証後、
同じWalkthrough IDとURI、`createdAt`を保って現在値を一つのSQLite transactionで置き換え、change
sequenceを更新する。過去値は保存しない。既存の文書全体commentは同じIDへ残る。publishとupdateは
passiveであり、browserを開かずnavigationも変更しない。
成功responseはpublishと同じ`{walkthrough, issuesAdded}` envelopeを返す。

#### Delete

```bash
rvw walkthrough delete <WALKTHROUGH_URI> --json
rvw walkthrough delete <WALKTHROUGH_URI> --yes --confirmation-token <TOKEN> --json
```

確認tokenなしは`WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED`と対象Walkthrough、reference、comment、postの
削除件数、review sequence、confirmation tokenを返してexit 2とする。明示authorization後、同じtokenを
`--yes`と返した場合だけWalkthrough、reference、対象comment、postを一つのSQLite transactionで物理削除し、
change sequenceを更新する。この削除はretained commit refを削除しない。

### 7.5 JSON transport contract

- machine consumerは`--json`または`--stdin --json`を必須とし、stdoutへJSON valueを一つだけ返す。
- 長時間の`comment watch`だけは`--json-seq`を必須とし、stdoutへRFC 7464 frameを複数返す。
- progressとdiagnosticはstderrへ出し、errorは`code`、`message`、`suggestions`を持つ。
- stdinは40 MiB以下の単一JSON objectとし、EOFを受けてからparseする。改行だけでは入力を終了しない。
  process callerはJSON送信後にstdinをcloseし、shell callerはpipe、quoted heredoc、input redirectionの
  いずれかを使って対話PTYでのEOF待ちを避ける。Agent socket frameはこの入力とprotocol envelopeを
  収める固定上限を持つ。
- comment本文とreplyはUTF-8 GFM Markdown sourceで64 KiB以下とする。comment postとWalkthroughの
  referenceはそれぞれ最大200件とする。
- `walkthrough get`はcurrent WalkthroughとPull RequestまたはRepository Reviewのidentity、local repository pathを返す。
- `comment list`は登録済みPRをURLまたは番号で受け、`unresolved`を既定に`resolved` / `all`も選べる。
  `limit`は既定50、最大100、`offset`は既定0とし、`total`、`hasMore`、`nextOffset`を返す。
  各threadはURI、state、target要約、post件数、root postの先頭512 bytes、latest headに対してserviceが
  導出したplacementだけを返し、PR本文は含めない。完全なtarget、全post、source excerptは
  `comment get`だけが返す。
- `comment get`はPR URL、repository path、最新title、base/head branchとOID、head repository owner/name、comparison base、comment
  target、posts、`createdHeadOid`、`latestHeadOid`、各postの`relatedCommitOid`、`references`、`lastModifiedBy`、latest headに対してserviceが
  導出したplacementを返す。既定ではPR本文を含めず、`--include-pr-body`指定時だけ最新の同期済み本文を
  `pullRequest.body`として返す。呼び出し側はOID比較でOutdatedを推測しない。
- `comment get --live`はGitHubの現在値をread-onlyで取得し、同期済みcacheを更新せず、`githubState`へ
  `liveCheckedAt`、`staleAgainstGitHub`、live metadataを返す。指定しない場合の値は`null`であり、GitHubを
  確認していないことを明示する。live metadataにはforkでもpush先を一意にできるhead repository
  owner/name、head branch、head OIDを含める。
- repository targetの`comment get`はexact source OID/pathとavailabilityに加え、line/rangeなら前後
  最大20行、file-levelなら先頭からのsource excerptを返す。excerptは最大200行、64 KiBとし、前後と
  byte上限による切り詰めを明示する。`availability`の値域は`available`（textとして取得可能。submoduleは
  OID text）、`binary`（NULを含むかUTF-8ではない）、`too-large`（1 MiB超）、`missing`（exact OIDにpathが
  存在しない）とする。`available`だけがexcerptを持ち、それ以外は`null`とする。Agentは必要な周辺contextを
  local repositoryのexact OIDから読む。
- standalone `comment reply`のstdinは`body`、任意の`authorLabel`、任意の
  `relatedCommitOid`、任意の`references`、任意の`idempotencyKey`を持つ。referenceがある場合は関連OIDを
  必須とし、対象PRで利用可能なcommitでなければならない。同じkeyと同じpayloadのretryは既存postを返し、
  異なる利用を拒否する。
- `comment edit`はcomment URIとpost IDを引数、stdinの`body`、任意の`relatedCommitOid`と`references`を
  入力としてpostを完全置換する。OID省略は現在値、reference省略は現在setを維持し、明示値は完全置換する。
  `null` OIDは関連を外し、非nullは対象PRで利用可能なcommitへ置き換える。同じ内容へのretryはpostを増やさない。
- `comment create`は登録済みPR、通常のcomment target、本文、任意の`authorLabel`、`relatedCommitOid`、
  `references`をstdinで受け、
  viewerと同じtarget validationから未解決threadを一件作成する。batch作成は行わない。
- comment postの`lastModifiedBy`は`human`、`agent`、既存行の`null`とする。viewer HTTPでの作成・返信・編集は
  `human`、Agent CLI / Agent socket / `pr sync`による作成・返信・編集は`agent`を保存する。これは通知用の
  経路情報であり、認証済みidentity、Agent専用comment state、caller入力にはしない。
- `pr sync`の`commentUpdates`は最大500件で、各要素は`commentRef`、`reply`、`resolve`と任意の
  `references`、`idempotencyKey`を持つ。referenceは同期したcurrent GitHub headへ固定する。
- breakingなprotocol schema変更ではprotocol versionを進める。additiveなcommandは同じversionへ新しい
  capabilityを追加する。いずれもCLI contract test、3つの共通Skill、README、`docs/cli-protocol.md`を
  同じ変更で更新する。

## 8. SQLite

OS user data directoryに一つのDBを置く。`node:sqlite`、WAL、foreign keys、busy timeoutを使う。
既定DB directory/fileは新規作成時だけ`0700` / `0600`へchmodする。既存pathはstatでmodeとownerを検証し、
安全ならchmodしない。新規pathへのchmodが`EPERM`でもstat結果が安全なら継続し、安全でない場合だけpath、
実値、期待値を含む明示errorにする。`RVW_DATABASE_PATH`を設定したDBは呼び出し側管理として既存pathを
chmodしない。rvwが不足directory/fileを新規作成する場合はchmodではなく作成modeで`0700` / `0600`にし、
既存pathのmode/ownerと推奨値との差は`doctor --json`へwarningとして出す。

通常権限のviewer processは`0700`のuser専用一時directory内へdatabase別Unix socket（`0600`）を
提供する。Agent CLIはDBを直接開く前に
socketへ同じapplication service操作を依頼する。`RVW_AGENT_SOCKET_PATH`未指定時はrequest送信前の接続失敗
だけ従来のdirect CLIへfallbackできる。明示時はそのsocketを必須とし、接続失敗またはDB不一致を
`AGENT_SOCKET_UNAVAILABLE`として返してdirect DBを開かない。全socket requestは期待DB pathを含め、viewerの
DBと一致する場合だけdispatchする。接続成立後にrequestを送信した操作はtimeout、切断、不正responseでも
direct実行へfallbackせず、結果不明の明示errorを返す。破壊操作の確認はCLIだけでなくsocket dispatchでも
検証する。

`rvw agent ping/status --json`はsocket path、接続結果、OS接続error詳細、期待／接続先DB、owner PID、選択
transport、fallback理由をmachine-readableに返し、人向け出力にも同じ診断項目を表示する。同じsocket
pathのlisten前にatomicなowner lockを取得し、一つのNode
processだけがsocket名を保持する。lockのowner PIDが生存中またはlockが安全に読めない間はtakeoverせず、owner
終了後だけexact inodeを確認してstale lock/socketを除去し、待機中viewerが引き継ぐ。`doctor --json`はDBの
mode/ownerに加えてrollbackするwrite transactionとAgent疎通を実行・報告する。

```sql
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- database-wide change_sequence、review kind/IDごとのreview_change_sequence、
-- global theme_preference、comment_watch_database_idを保持する。

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL,
  github_url TEXT NOT NULL,
  latest_author_login TEXT,
  latest_head_repository_owner TEXT,
  latest_head_repository_name TEXT,
  local_repository_path TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  latest_title TEXT NOT NULL,
  latest_body TEXT NOT NULL,
  latest_base_ref_name TEXT NOT NULL,
  latest_head_ref_name TEXT NOT NULL,
  latest_base_oid TEXT NOT NULL,
  latest_comparison_base_oid TEXT NOT NULL,
  latest_head_oid TEXT NOT NULL,
  github_updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(host, owner, repository, number)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  created_head_oid TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE comment_targets (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  document_kind TEXT,
  source_oid TEXT,
  file_path TEXT,
  source_document_hash TEXT,
  quoted_text TEXT,
  walkthrough_id TEXT REFERENCES walkthroughs(id),
  start_line INTEGER,
  end_line INTEGER
);

CREATE TABLE comment_posts (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  related_commit_oid TEXT,
  author_label TEXT,
  is_root INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE comment_post_references (
  post_id TEXT NOT NULL REFERENCES comment_posts(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  label TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  description TEXT,
  sort_order INTEGER NOT NULL,
  CHECK((start_line IS NULL AND end_line IS NULL) OR
        (start_line IS NOT NULL AND end_line IS NOT NULL AND start_line > 0 AND end_line >= start_line)),
  PRIMARY KEY(post_id, reference_id)
);

CREATE TABLE comment_reply_idempotency (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE comment_post_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL UNIQUE,
  comment_ref TEXT NOT NULL,
  pull_request_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE walkthroughs (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  source_oid TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_label TEXT,
  diagram_bindings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE walkthrough_references (
  walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  label TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  description TEXT,
  sort_order INTEGER NOT NULL,
  CHECK((start_line IS NULL AND end_line IS NULL) OR
        (start_line IS NOT NULL AND end_line IS NOT NULL AND start_line > 0 AND end_line >= start_line)),
  PRIMARY KEY(walkthrough_id, reference_id)
);
```

`comment_reply_idempotency`というtable名はmigration 009由来だが、このledgerはprotocol v4で
Pull Request／Repository Review replyの双方が共有するdatabase-wide keyspaceである。
Repository Review replyのrequest hashはreview kindを含む。PR replyは公開済み0.2.xが保存した
`comment.reply`と`pr.sync.comment-update`のhash形式を維持し、migration後もexact retryで既存postを返す。

Repository ReviewとIssue追加migrationは、canonical Issue cacheの`github_issues`、実owner FKを持つ
`pull_request_issues` / `repository_review_issues`、nativeなPR `comment_targets.target_kind = issue`、repository
singletonの`repository_reviews`、およびRepository Review専用のWalkthrough、Comment、post、typed reference tableを追加する。
Repository Review schemaをversion 011として記録した未公開development DBは自動upgradeせず、関連tableを一つでも
検出した場合は012を記録する前にfail closedしてDBの退避・再作成を要求する。公開済み0.2.x DBだけが通常の
011 comment provenanceから012へ進む。初期version snapshot後のtable検査で関連tableを検出した場合はversion 12を
再確認し、別processが同じtransactionで正常にDDLとversion記録をcommit済みならfail closedせずその結果を採用する。
PRとRepository Reviewのartifact ownershipとcascade境界は分離し、
共有Issue cacheの表示内容が変わった場合だけ、そのIssueを所有する全Reviewの
`review_change_sequence`を同じtransactionで更新する。membership固有の同期errorはそのReviewだけを更新し、
単なる`fetched_at`更新では他Reviewをinvalidateしない。
cache更新はGitHub `updatedAt`の非減少を保証し、同一versionのcontent conflictを拒否する。sync error更新は
元fetchの内部`cache_generation`がcurrentの場合だけ許可する。accepted successはgenerationを増やすため、
同じmillisecondに保存された新しいcacheへ古いfailureがerrorを付与できない。
Issue membership追加と既存membershipのrefreshは別操作とする。refresh成功／失敗はGitHub fetch後のimmediate
transactionで元reviewとmembershipの存続を再確認し、削除済みならcache、membership、全Reviewのsequenceを変更しない。
Issue targetのComment作成もapplication層の本文／range検証後、Comment、target、root post、event、sequenceを
書く同じimmediate transaction内で対象Reviewのmembershipを再確認する。確認後にmembershipが削除されていれば
`ISSUE_NOT_FOUND` (404)とし、別Reviewが共有cacheを保持していてもCommentを作成しない。
PR本文に現在も直接含まれるIssueだけは追加操作として扱い、次回refreshで再登録できる。PR／Repository Review viewerはreview
sourceの同期成功とIssueごとの部分失敗を区別し、`issueResults`の失敗をresponse-local warningとして表示する。
top barのdetailは先頭3件と残件数に省略する。

commit table、review version table、PR revision tableは持たない。既存Phase 1 DBはmigrationで
version参照をcommit OIDへ移し、旧PR本文コメントはquoteが復元できない場合Outdatedとして残す。
既存の`refs/rvw/pr/<n>/version/...`は旧comment source objectを失わないよう保持し、resetでも削除しない。
以後の同期だけがcommit ref形式を使う。将来の明示的・排他的GCまでhistorical evidenceとして残す。
Comment、reply、Walkthroughはexact source refをSQLite書き込み前に確保する。通常の書き込み失敗では
補償削除しない。refの`created`はそのGit commandが初回作成したことだけを示し、同じPR／Repository ReviewとOIDを
共有する別processの正常なartifactが依存していないことを証明しない。ただしRepository Reviewでは、当該writeが
exact refを作成し、SQLite失敗後にaggregate IDの消失を確認した場合だけ、expected OID付きでそのrefをbest-effort
削除する。aggregateが残る場合、refが既存だった場合、削除に失敗した場合は保持する。その他の未参照ref回収は
将来の明示的かつreview-scopedな排他的GCへ委ねる。

## 9. Application / API

主なHTTP API:

```text
GET  /api/pull-requests/:id
POST /api/pull-requests/open
POST /api/pull-requests/:id/refresh
POST /api/pull-requests/:id/reset
GET|POST /api/pull-requests/:id/issues
GET /api/pull-requests/:id/issues/:issueId
DELETE /api/pull-requests/:id/issues/:issueId

GET /api/pull-requests/:id/commits
GET /api/pull-requests/:id/tree?oid=<oid>
GET /api/pull-requests/:id/changed-files?oldOid=<oid>&newOid=<oid>
GET /api/pull-requests/:id/document?kind=...&sourceOid=...&path=...
GET|HEAD /api/pull-requests/:id/markdown-asset?sourceOid=...&path=...
GET /api/pull-requests/:id/github-attachment?url=...
GET /api/pull-requests/:id/diff?oldOid=...&newOid=...&oldPath=...&newPath=...
GET /api/pull-requests/:id/search?oid=<oid>&q=<query>&matchCase=<bool>&wholeWord=<bool>
GET /api/pull-requests/:id/walkthroughs
GET /api/pull-requests/:id/walkthroughs/:walkthroughId
DELETE /api/pull-requests/:id/walkthroughs/:walkthroughId

GET  /api/repository-reviews/:id
POST /api/repository-reviews/open
POST /api/repository-reviews/:id/sync
POST /api/repository-reviews/:id/reset
GET /api/repository-reviews/:id/tree
GET /api/repository-reviews/:id/document?kind=...&sourceOid=...&path=...&issueId=...
GET|HEAD /api/repository-reviews/:id/markdown-asset?sourceOid=...&path=...
GET /api/repository-reviews/:id/github-attachment?url=...
GET /api/repository-reviews/:id/search?q=<query>&matchCase=<bool>&wholeWord=<bool>
GET|POST /api/repository-reviews/:id/issues
GET /api/repository-reviews/:id/issues/:issueId
DELETE /api/repository-reviews/:id/issues/:issueId
GET /api/repository-reviews/:id/comments
GET /api/repository-reviews/:id/walkthroughs
GET /api/repository-reviews/:id/walkthroughs/:walkthroughId
DELETE /api/repository-reviews/:id/walkthroughs/:walkthroughId

GET  /api/pull-requests/:id/comments
POST /api/comments
POST /api/comments/:id/posts
PATCH /api/comments/:id/posts/:postId
DELETE /api/comments/:id/posts/:postId
POST /api/comments/:id/resolve
POST /api/comments/:id/reopen
DELETE /api/comments/:id
GET  /api/comments/:id/placement?...
```

HTTP/CLIは同じapplication serviceを使用し、transportへbusiness logicを書かない。

Repository Review lifecycleはapplication層でopen-or-createと、次のdiscriminated resolution policyへ分類し、
CLI、Agent socket、HTTPが同じuse caseを呼ぶ。

- `open-or-create`: `repository open`。保存済みbindingを検証してcacheを開き、未登録時だけGitHub同期後に作成する。
- relocation: `repository relocate`。canonical identityとDB参照中の全review-owned source ref／objectを検証し、
  evidence件数を含むsequence付きpreviewの明示確認後だけ同じaggregateの保存locationを移動先cloneへ更新する。
- `{ kind: "read" }`: `repository comments`と保存済みartifact read。row、ref、fetch、locationを作らない。
- `{ kind: "synchronize" }`: `repository sync`。保存済みaggregateとlocal remoteを検証してからだけ同期する。
- `{ kind: "destructive", allowMissingInitialRef }`: resetとRepository Issue removalのpreview／実行。missing
  initial ref例外を型上resetへ限定する。未登録なら
  `REPOSITORY_REVIEW_NOT_FOUND`で、previewを含めsequence、DB、refを一切変更しない。
- 明示的追加: `repository issue add`だけは未登録reviewを作成できるが、remote identityを解決・検証できない
  状態では実行しない。

HTTPの`/api/repository-reviews/:id`配下から始まるsync、Issue add/remove、comments readは、routeで保存pathへ
変換してpath-based use caseへ渡さない。`expectedRepositoryReviewId`をbinding resolverからDB upsert／membership
transactionまで保持し、待機中に対象IDがreset/recreateされた場合は旧IDへ
`REPOSITORY_REVIEW_NOT_FOUND`を返す。replacement aggregateのsource、membership、Comment、sequence、refは変更しない。
CLIとAgent socketのpath-based use caseは、指定pathに現在bindingされるreviewを対象とする。

Repository Review read routeは次の契約へ分ける。

| read境界                   | 対象                                                                                            | 必須検証                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| DB-only archive read       | Issue本文、Walkthrough本文、Comment本文                                                         | owning review row／membership／artifact owner                                     |
| aggregate-bound read       | Review本体、同期、Comment一覧                                                                   | 保存path、Git common directory、解決可能なcanonical remote、current owned ref     |
| source-evidence-bound read | tree、repository document／asset／search、exact comment source、placement、typed code reference | aggregate bindingに加え、利用する全source OIDのreview-owned exact refとGit object |

path-based Comment一覧はresolverが検証した指定worktreeをevidence確認、document read、diffへ一貫して渡し、
保存済みworktree pathへ戻さず、readによってlocationやsequenceを更新しない。source evidenceはOIDをunique化して
先に検証し、配置計算は最大8件を並列処理する。一件でも
historical owned refまたはobjectが欠損した場合は、document readと同じ`COMMIT_NOT_FOUND`で一覧全体を
fail closedし、偶然別refから到達できるobjectをRepository Review evidenceとして読まない。

PR／Repository Review reset、Issue removal、Walkthrough deletionのpreviewはreview change sequenceと、review ID、
対象ID、件数、削除対象のreview-owned refを含むconfirmation tokenを返す。PR resetのretained refsは
preserved情報として返し、削除件数やtoken対象へ含めない。実行は同じtokenを必須とし、SQLiteの
mutation transactionでもexpected sequenceを再検証する。relocationも全evidence状態をtokenへ含め、変更済みなら
`DESTRUCTIVE_PREVIEW_STALE` (409)の
detailsへ最新previewを返し、利用者へ再確認を要求する。最終SQLite CASで競合を検出した場合もservice層で
previewを再構築し、relocationを含めRepository Review metadataを含む同じerror shapeをcurrent rowから返す。PR resetはGitHub I/O後、
head ref確保前にもtokenを再検証し、commit一覧をSQLite mutation前に取得して、成功したDB reset後へ失敗可能な
Git readを残さない。

canonical identity検索、Git common directory検索、conflict判定、ID決定、insert/update、review change
sequence更新は一つの`BEGIN IMMEDIATE`内で行う。canonical owner/repositoryのSQLite一意性も`NOCASE`とし、
同じidentity・同じcommon directoryの同時初回openは同じIDを再利用する。identityとcommon directoryの
片方だけが一致する場合はraw SQLite constraint errorではなく`REPOSITORY_MISMATCH`を返す。

## 10. Viewer UX

Viewerの最優先目的は、選択commitが作るrepositoryの状態を利用者が見失わずに読み進めることである。
初期表示は全文とし、変更fileとdiffはrepository readingを開始するindexとして扱う。利用者が
関連file、test、設定、documentへ移動してもcommit範囲とopen documentを維持し、diff外へ出たことを
理由にreview contextを作り直させない。

最上部のtop barにPR情報と、repository全体へ作用するcommit範囲、表示、diff styleを並べる。
同期とreset actionは右端の`...` menuへ格納し、通常時の縦幅を増やさない。
各paneのtab列はPR、repository file、Walkthroughの文書navigationだけに使う。

```text
top bar
PR情報  対象commit                                      表示            Diff表示           [...]
        [ subject A … subject D · 4 commits · PR全体 ▼ ] [ 全文 | 変更 ] [ stacked | split ]

commit range popover
[ PR全体 ] [ 最新だけ ]
○ subject D · dddddddd  最新    ┐ clickで一件
● subject C · cccccccc           ├ dragで連続範囲
● subject B · bbbbbbbb           ┘
○ subject A · aaaaaaaa

... menu
[ GitHubと同期 ]
[ ローカル状態を削除して再構築 ]

tab row
[ Pull Request.md ] [ src/example.ts ]
```

- 初期表示はlatest headまでのPR全体を選択し、全文を表示する。
- 更新前にlatest headを見ていた場合、refresh成功後はnew latest headへ進む。
- historical commitを選択中ならrefresh後も選択を維持する。
- refresh開始後に利用者がcommit範囲を変更した場合、終了点が更新前のlatest headのままでもnew latest
  headへ自動追従せず、その操作時の開始点と終了点を維持する。
- PR本文はselectorと無関係に常にlatest cacheを全文表示し、global controlがdiff modeなら
  `差分なし · 全文表示`を明示する。
- 未送信comment draftはPR、pane、文書、exact source、commit範囲、表示modeごとに分離し、tab切替や
  tabの閉じ直しでは保持する。送信、明示cancel、comment targetへのnavigation、reset成功時に破棄する。
- 明示capture button、未取り込みbanner、version selectorは存在しない。
- refreshは取得・ref保持・cache更新を一度に行う。

ファイル、コメント、検索、diff style、line selectionの既存UXは維持する。PR本文とWalkthroughはExplorer先頭の
virtual rowとして表示し、Walkthrough folderを展開して選択すると説明tabを開く。本文検索はExplorer headerから
Search viewへ切り替える。説明tabはMarkdown本文とdiagramを持ち、重複するcode reference indexは持たない。本文のinline
referenceまたはbinding済みdiagram nodeを選んだ時だけ
exact source tabへ移動し、説明tabと既に開いているcode tabはworking setとして残す。必要なら最大二つの
横ペインへtabを移動し、Walkthroughとsource、二つのsource、Markdown previewとcodeを並べて読む。
exact source tabを開く操作は対象commitやglobal表示を変更せず、参照先を取得できない場合はtabを開かず
Walkthrough上の一時chipで通知する。
CLIによる同一ID更新はpoll後に開いているtabへ反映する。viewerの削除actionは紐づくcommentとpostの件数、
参照が無効になること、不可逆性を確認してから実行し、成功後はtabとsidebar itemを閉じる。

## 11. Reset

`rvw pr reset <PR> --yes --confirmation-token <TOKEN>`は対象PRのlocal comments、posts、targets、Issue membership、
Walkthrough、code referenceを削除し、現在のGitHub状態を同期してcurrent head refをnon-destructiveに確保する。
再構築後に返すcommit一覧は削除transactionより前に読み、Git readに失敗した場合はSQLite artifactを保持する。
`refs/rvw/pr/<n>/...`のhistorical refsはimmutable evidenceとして保持し、`counts.gitRefs = 0`とする。削除件数を事前表示し、
CLIはpreviewのconfirmation tokenと`--yes`を必須とする。不可逆であり、明示的な利用者authorizationなしにAgentが実行しない。

`rvw repository reset --repository <PATH> --yes --confirmation-token <TOKEN> --json`はexisting-onlyでbindingを検証し、対象review ID配下の
`refs/rvw/repository/<repositoryReviewId>/...`だけをpreview／削除する。DB削除後にref削除が失敗した場合は例外で
削除済みreviewを保持せず、`completed-with-orphan-refs`というtyped success outcomeへDB削除済み、review ID、
ref prefix、残存ref、manual cleanup可能性を含める。0.3.0にはrvw管理下のorphan-ref cleanup commandを追加しない。
残存refはorphanとして新しいreview IDから隔離され、新reviewは旧evidenceを受理せず、旧reset retryも
新reviewのrefを削除しない。「再作成すればorphan cleanupされる」とは案内しない。保存pathが削除・置換され、
Git common directoryとreview-owned source refを検証できない場合はDB rowを削除しない。
初回rowはsource ref作成前から`initialization_state = pending`を保存し、`source_sync_error`と分離する。ref作成前にprocessが停止した場合は、通常
read／syncを`LOCAL_STATE_INCONSISTENT`のまま扱い、明示resetに限りexpected review ID、Git common directory、
canonical remote（またはremoteなし）、非ready state、review ID配下のrefが0件であることを検証してrowを削除できる。
通常readは`pending`だけを最大5秒pollし、`failed`または`ready`のmissing refは即時に拒否する。
ref作成後、ready化前に停止した場合は、次回openがexpected ID／source OID、owned ref、Git objectを検証して
`ready`へ進める。初回lookupではrowがなくても、初期化用immediate transactionが既存rowを発見した場合は
source OID、default branch、location、sync errorを変更せず`created: false`を返す。呼び出し側はwinnerのowned
sourceを検証し、aggregate発見前に取得したsnapshotを破棄する。その後generationを確保し、GitHub metadataを
再取得してからretainし、expected Repository Review ID付きtransactionでだけ既存sourceを更新する。generationなしで
既存Repository Review sourceを変更できるunrestricted upsertはapplicationへ公開しない。初期ref作成とresetが競合し、
aggregate削除後にrefが作成された場合は、そのattemptが作ったexact refだけをbest-effortで削除する。この例外を
Issue removalその他のdestructive操作へ広げない。
既存aggregateのsource同期はGitHubアクセス前に`source_sync_generation`を増やす。candidate ref作成後のsource公開と
sync error保存はexpected review IDと同じgenerationを一つのimmediate transactionで再検証し、古い試行は新しい
source、location、error、change sequenceを変更しない。
初期retained ref作成はall-zero old OIDを指定したGit `update-ref`のcompare-and-swapで行い、
同時作成時には1件だけが`created: true`を得る。`initialization_state = ready`後のcompletionは冪等とし、
後続syncでsourceが進んでいても失敗にしない。補償削除はexpected aggregate IDが存在しない場合だけとし、
source不一致を根拠にhistorical evidenceを削除しない。

## 12. Server / security

- Node 24 LTS、Hono、React/Vite、TypeScript strict、pnpm 11
- `127.0.0.1`の空きportだけへbind
- expected Hostを検証
- write APIは`application/json`だけ
- same-origin以外のwriteを拒否、CORSを有効にしない
- GitHub attachment readも存在するFetch Metadataと`Origin`でsame-originへ限定し、画像responseへ
  `Cross-Origin-Resource-Policy: same-origin`を付ける
- browser tab leaseはtransport-onlyで永続化しない
- 通常の自動openはPRごとのbackground workerを起動し、worker ready後にbrowserを開き、最初のviewer
  heartbeatを確認してから親CLIを終了する
- browser起動失敗、worker error、30秒以内に最初のviewer heartbeatがない場合はworkerを停止して明示的な
  errorを返す
- background workerはpersistent daemonではなく、最後のviewer tab終了後にserverとともに停止する
- `--foreground`と`--no-open`はsignal管理
- SQLiteはWALでserver processを扱い、Agent CLIの書き込みは可能ならuser専用Unix socketを経由する

同一Reviewを複数viewer/processで開くことは許容する。SQLite writeは`BEGIN IMMEDIATE`を使う。
Phase 1ではDBとGit refを単一transactionにできないため、失敗時の補償削除と起動・同期時の
invariant検証を行う。refとSQLiteの不整合を検出した場合は部分的に自動修復せず、error detailsに安全な
明示repair境界を返す。

## 13. Error方針

ユーザー修正可能errorはcode、短いmessage、具体的suggestionsを返す。silent fallbackしない。

- gh/git未導入・未認証
- PR URL不正、未登録、closed/merged sync
- base repository mismatch
- object fetch失敗
- local changes未commit、head未push
- dirty判定errorには対象repository pathとstatus entry一覧を含める
- invalid commit range / object / path
- invalid Walkthrough reference / Mermaid binding / line range
- refとOID不整合
- binary / too large
- stale protocol

保存済みPRのGitHub更新失敗はcache表示を壊さない。UIへ更新errorを表示する。

## 14. テスト

Unit:

- PR Markdown生成・hash・quoted range mapping
- rendered Markdownのsource position付与、文字列選択からsource line rangeへの変換
- commit log parse
- line mapping、rename、Outdated
- comment resolve/reopen、URI、CLI/API schema
- Walkthrough schema、URI、Markdown reference validation、行comment placement
- DB migration 001→current

Integration（実git + fake GitHub）:

- local-first reopen
- initial sync、linear update、force-push update
- immutable head refsとreset
- commit list、tree、full、range diff、search
- current baseのmerge-backを含む履歴で、PR先頭からのdiffがfirst parentではなくcomparison baseを使い、
  current baseに含まれない中間mergeからのrangeはfirst parentを維持すること
- realtime searchのcase/whole-word、file grouping、全展開／折りたたみ、表示modeを保つline jump
- PR本文latest-only更新
- code/PR本文comment placement
- `pr sync` replyのrelated commitとresolve
- `pr sync --repository`、`--allow-untracked`、behind-onlyなlocal branch
- repository外からの保存済みPR openと`pr attach`
- `comment get --live`のread-only stale判定
- Agent socket経由のwrite、implicit fallback、explicit fail-closed、diagnostic、process間単一owner takeover
- doctorのDB write transactionとAgent疎通
- commit固定Walkthroughの登録、取得、同一ID完全置換、全体／行comment保持とOutdated、確認付き削除、reset削除
- worktree間共有

E2E:

1. PRを開きlatest commitと最新Pull Request.mdを表示
2. commit subjectで一件選択へ切り替え、open tabを維持
3. click、drag、PR全体shortcutを使うinclusiveなcommit range diffとlatest表示
4. 全ファイルから未変更fileを開く
5. 行comment、URI copy、reply、post edit/delete、resolve時の折りたたみ
6. refreshでnew commitへ更新し、historical commit選択時は維持
7. headを変えないPR本文だけのrefreshで、行数が変わった最新本文を末尾まで表示
8. 既存PR本文commentのinline位置とOutdated表示を同じrefreshで更新
9. old code commentのtrackingまたはOutdated
10. Walkthroughを開いてもcode tabを自動で開かず、inline referenceまたはMermaid nodeを人間が
    選んだ時だけ対象commitを変えずexact source行へ移動し、説明tabを保持。missing時はtabを開かず
    一時的なリンク切れchip、通信や一時的な取得失敗では区別したstatusを表示
11. tabをdragまたはpane menuで左右へ移し、通常clickでreferenceを左pane、`Cmd` / `Ctrl`+clickで
    右paneへ開く。同じfileを参照している場合も左右に一つずつ保持し、参照先paneだけを指定行へ移動する
12. repository MarkdownをSource / Previewで切り替え、Previewの文字列選択からsource行commentを作成する
13. flowchartとclass diagramのbinding済み要素からexact sourceを開く
14. CLI更新したWalkthroughのtitle、本文、referenceを同じopen tabへpoll反映
15. Walkthroughの文字列選択へ行comment、Mermaid fenced block全体へcommentを作成し、Mermaid composerは
    入力中に同じtextarea DOMとcaretを維持して正順に入力でき、本文置換後に一意なquoteは再配置、
    一意に置けないquoteはOutdated表示
16. viewerでWalkthroughと紐づくcomment件数を確認して削除し、tabとcommentを同時に除去
17. root commentとreplyのGFM、soft line break、sanitize、repository内link、同一commit相対画像、
    表示専用Mermaid、post単位のtyped code referenceをsidebarとinline threadでrenderし、編集時は
    元Markdown sourceを表示する。referenceはrelated commitのexact sourceへ開き、壊れた参照は
    Walkthroughと共通のstatusを表示する
18. file、tab、Search result、comment、Walkthrough reference、Markdown相対／見出しlinkを辿ったbrowser
    Back / Forwardがfocused paneの文書と位置を復元し、行jump後に手動で読み進めた位置、反対paneのtab、
    現在のcommit範囲、表示mode、tree modeを維持。reloadは初期一時workspaceへ戻る

CLI contract:

- stdout JSONのみ、stderr progress/error、exit code、stdin sizeとschema
- protocol versionとcapability
- `comment create`のtarget normalization、viewer共通validation、未解決root作成、非冪等契約
- `comment list`の未解決既定filter、resolved/all filter、最大100件のpagination、512 bytesのroot
  preview、latest placement、全replyを読み込まないbounded query
- `comment get`の最新PR metadata、PR本文の既定省略と`--include-pr-body` opt-in、service導出placement、
  bounded exact source excerpt
- resolved threadへのreplyが自動reopenしない状態契約
- cursorless watchが既存postをskipし、新規root/replyだけをDB-wide sequenceで返すこと
- watch cursorのresume、別DB拒否、削除後event、minimal payload、RFC 7464 framing
- replyとsync updateのidempotency key retry、head advance、payload conflict、result削除
- task state scriptのatomic ingest、lease recovery、batch単位status post再利用、後続replyでの新規status post、
  即時ackの自己event抑制、予約済みworker容量によるin-flight制限、同一PR後続batchとdue retryのevent非依存drain、
  acknowledgement authorのmutation前固定と再開時不一致拒否、repository write直列化、旧task DBの未完了batch
  mapping移行、status post削除後の再生成
- `comment edit`のbody完全置換、related commit維持／解除／更新、Agent socket経由write
- comment create/reply/edit/syncのpost単位reference検証、保存、完全置換、commit保持、idempotency
- `walkthrough get/publish/update/delete`のvalidation、同一ID更新、削除件数、passive navigation contract
- `pr sync`のreply/head関連付けと非冪等時の再取得
- 3つのSkillの初回install、同一内容の再install、いずれかに差異がある場合の更新検知と`--force`
- Skill installerが対象Skill directory外を変更しないこと
- `skill status --json`のschema

Package smoke:

- tarballへ`dist`、migrations、Skills、CHANGELOG、README、SECURITY、LICENSEだけを必要範囲で含める
- CLIはNode built-in以外のruntime依存を`dist/cli.mjs`へbundleし、package manifestにruntime
  `dependencies`を残さない
- 空のnpm cacheを使ってtemp prefixへoffline global installし、`rvw --version`と`rvw doctor`を実行
- temp Skill rootへCodex / Claude Code向けの同じ3つのSkillをinstallし、`skill status --json`で一致を確認
- static assets、migrations、`rvw` / `rvw-walkthrough` / `rvw-watch-comments` Skill assetがtarballに存在することを確認

必須commands:

```bash
pnpm check
pnpm test
pnpm test:e2e
pnpm build
pnpm test:package
```

## 15. CLI / Skill配布

Phase 1 packageは`name: rvw`, `private: true`でnpm publishしなかった。Phase 2 packageは
`@a9n-shoji/rvw`としてCLI、web assets、migrations、Skillsを同梱する。npm accountまたはorganizationが
`a9n-shoji` scopeを管理できることを初回publish前のexternal gateとする。

```bash
rvw skill install codex
rvw skill install claude
rvw skill status
```

既存Skillが同一なら成功する。rvwによるinstall時に同梱digestをmarkerへ記録し、status/doctorは現在の
同梱版との差だけでなく、管理済み旧版の`updateAvailable`、`locallyModified`、markerのない
`unmanaged-difference`を区別する。差異があるinstallは`--force`を要求する。`--target`はpackage smokeと
明示的custom rootに使い、`skill status`ではplatformも必須とする。Skillはlocal DBとrepositoryへ
アクセスできるlocal Agentだけを対象とする。

Skill sourceはcwdではなく実行中CLIのpackage rootを基準に解決する。`--force`でも対象Skill
directory以外を削除しない。一度のinstallでコメント取得・返信・sync用の`rvw`と、Walkthroughの
検証・publish・current値更新・確認付き削除用の`rvw-walkthrough`、新規post監視用の
`rvw-watch-comments`を配置する。三つのSkillの名前と内容はCodex / Claude Codeで共通とし、
platform adapterが変えるのは既定のSkill rootだけとする。Agent名はSkillへhardcodeせず、CLIの任意
`authorLabel`として実行中Agentが正確に判断できる場合だけ渡す。

`rvw-walkthrough`は一つのcurrent `sourceOid`、exact code reference、Mermaid binding、passiveなpublishと
同一ID更新、削除の明示authorizationを規定する。説明の見出し、順序、分割、粒度、diagram選択はsessionの
requestとrepository contextへ委ね、固定の文書templateを要求しない。Walkthroughはreviewerが変更または
明示された実装対象のmental modelを作るための最初の読解経路とし、作成指示を優先して、未指定部分だけを
既定guideで補う。diffやfileの一覧、網羅的なAI review、完全性の保証にはしない。更新時は既存artifactを読んで完全置換し、
改訂版を別artifactとして暗黙にpublishしない。削除は対象と件数への明示authorizationなしに実行しない。

`rvw-watch-comments`は一つの外部Agent taskをreceiverとして使い、cursorless起動で既存未解決を処理せず、
新規root/replyをreview contextごとのbatchへまとめる。同梱preflight、watch driver、state script、auto-ackが
prerequisite確認、cursor resume、RFC 7464 ingest、pending通知、queue、lease、retry、comment URIごとの
batch単位status post、自己event抑制をrepository外のSQLiteで管理する。Pull Request batchは検知直後に
batch単位status post、自己event抑制をrepository外のSQLiteで管理する。watch driverはstate DBごとの
process owner lockをrvw起動前に取得し、同じtaskの二重起動を拒否する。異常終了後のlockは記録したowner
processが存在しない場合だけ回収する。検知直後に各threadを再読込して
`🔎 確認中です…`をLLM往復なしに返信し、完了またはterminal failureでは同じreplyを最終結果へ編集する。
watcher起動時に実行中Agentを正確に識別できる場合は、その名前をdriverへ渡して確認replyの
`authorLabel`へ保存し、最終結果への編集後も維持する。識別できない場合だけ省略を許す。
同じthreadへの後続replyは新しいbatchで新しいstatus postを作り、以前の最終回答を保持する。
親taskはintake、dispatch、task state、最終replyだけを所有し、batchの大きさ、mode、変更有無にかかわらず、
acknowledge済みleaseを同じscheduling turn内で一つのfresh subagentへ必ず委譲する。親taskによる直接調査・
実装と、複数leaseの後回しの一括委譲を認めない。親taskは起動前にsubagent slot数を予約し、driverの
`max-in-flight`は8を目標に、8枠を保証できれば8、それ未満なら保証できる最大の正数、複数枠を保証できなければ
1を指定する。予約数を超えてはならない。driverはlimit未満だけauto-ackし、task stateを短周期で再確認する。
investigate-and-replyだけを許可したtaskでは同一PRのactive lease中に到着したeventも別leaseとして並列委譲する。
Repository Review leaseはtask全体のpolicyにかかわらず常にread-onlyで同一repositoryへ並列委譲できる。fix-and-pushを
許可したtaskではPull Requestの後続eventを先行lease解放後まで待たせ、repository writerもwrite reservationで
直列化する。retryable failureは`nextAttemptAt`到達後に、新しいwatch eventやreconnectを待たずauto-ackする。
subagentを速やかに起動できない場合はleaseをretryable
failureへ戻し、親taskが代行しない。subagentごとに一leaseだけを割り当て、絶対pathのatomic JSON fileを
唯一の最終結果回収経路にする。Repository Review batchはacknowledgementを作らず、同じ即時委譲規則で調査し、
厳格に検証したworker resultから一件のfinal replyを投稿する。subagentの最終結果はbody、
`relatedCommitOid`、完全なtyped reference配列、push状態を持ち、具体的なcode上の結論、実装、testには
navigation価値のあるexact rangeを既定で付ける。task起動時の
明示許可がある場合だけ、live authorが起動時
GitHub loginと一致し、head repository/branch/OIDとpush先も一致するPRをfix-and-pushにできる。他人または
不明なPRはinvestigate-and-replyとする。rvw自身はAgent sessionやtask stateを管理しない。

Phase 2ではnpm account、scope、2FA、LICENSE、README、CHANGELOG、SECURITY、dependency license、
macOS/Linux/Windows smokeを確認してから公開する。通常CIはregistryへ書き込まない。release workflowは
手動dispatch、`npm-production` Environment、GitHub-hosted runner、`id-token: write`を使い、OIDC
Trusted Publisherには`npm stage publish`だけを許可する。version、APP_VERSION、stable tag、CHANGELOGを
検証し、package smokeがinstallした同一tarballをstageする。人間が内容を確認し、2FAでapproveするまで
publicにはしない。

npmは未作成packageへTrusted Publisherを設定できずstaged publishingも受け付けないため、最初の`0.1.0`
だけはcleanなtag checkoutで検証した同一tarballを2FA付きdirect publishする。長期publish tokenは作らず、
初回公開直後にstage-only Trusted Publisherを設定して従来tokenを禁止する。詳細は`docs/releasing.md`を
source of truthとする。

## 16. Phase 1 Definition of Done

Functional:

- URLまたはcurrent branchからopen/draft PRを開き、登録済みPRはofflineでも再表示できる。
- `rvw repository open`でrepository singletonのRepository Reviewを開き、default branch名とsource OIDを表示し、
  同じGit common directoryのworktreeとoffline openから同じreviewを再利用できる。独立cloneからはbindingを
  変更せず失敗し、明示reset後にだけそのcloneで作り直せる。同じcloneのdirectory移動は通常openで暗黙rebindせず、
  DB参照中の全exact owned source evidenceを検証したpreview token付きの`repository relocate --yes`後にopen、sync、Comment、resetを再利用できる。
- 未登録repositoryのRepository Review reset／Issue removal previewと実行、comments、syncはreviewを暗黙作成せず、
  `REPOSITORY_REVIEW_NOT_FOUND`後もDB row、retained ref、change sequenceを変更しない。remote mismatchは全transportで
  mutation前に拒否し、`source_sync_error`へ記録しない。
- Pull Request / Repository Reviewへ同一repository Issueを追加し、番号降順で通常文書として二ペイン表示、
  全体・source range Comment、Outdated追跡を利用できる。
- Issue番号/titleとowned Comment/reply件数をpreviewした明示確認後、選択reviewのmembershipとIssue feedback
  だけを削除でき、別reviewの同じIssueは残る。preview後のsequence変更はtoken不一致で削除せず再確認する。
- 共有Issue cache documentとreview membership documentを型で分け、後者だけが`syncError`／`stale`を持つ。
  `comment get`はComment所有Reviewのmembership-aware getterを使う。Walkthrough `issuesToAdd`による正常な
  membership ensureは、既存membershipなら追加扱いにせず、そのReviewのsync errorだけをclearする。
- Repository Review resetはIssue、Comment、Walkthrough、review recordとRepository Review専用retained ref候補をpreviewし、
  `--yes`後にRepository Review固有状態とそのreview IDのrefだけを削除する。再openは新しいIDの空reviewを作り、失敗した
  旧resetのorphan refを証拠として継承しない。browserでreset成功後の再openだけが失敗した場合はreset完了と
  再作成失敗を分けて表示し、repository pathと`rvw repository open`による復旧を案内する。DB削除後のref cleanup
  失敗もtyped partial successとして同じ削除済みUI stateへ移り、隔離されたprefixを表示する。
- Repository Review WalkthroughとCommentを既存URI/CLIで扱い、watcherは明示contextでbatchしてread-only調査後の
  最終replyだけを冪等に記録し、そのpost eventをdurableにself-suppressできる。
- Repository Issue range comment draftはbackground sync中も本文とfocusを保持し、Issue本文変更時はdraftを失わず
  古いrangeの送信を拒否する。同期後の本文、inline placement、sidebar Outdated表示は一致する。
- Walkthrough publish/updateはreview kindとtransportによらず`walkthrough`と`issuesAdded`を返す。
- 外部Repository Walkthrough更新はreloadなしにlist/detail、左右pane、本文、reference、diagram bindingへ反映し、
  無関係なcomment draft、focus、pane配置、scrollを失わない。
- destination commit選択、PR全体diff、複数commit range、changed/all tree、全文、検索を利用できる。
- `Pull Request.md`は常に最後に成功した同期の最新内容だけを表示する。
- Agentがcommit固定WalkthroughをCLIで提示し、feedback後は同じIDのcurrent値を改善でき、人間が任意の
  referenceだけを最大二ペインのtabで検証できる。不要なWalkthroughは件数確認後に削除できる。
- PR全体、PR本文、file、line/range comment、reply、post edit/delete、resolve/reopen、sidebar、Outdatedが機能し、
  postはsafe GFM、repository link／相対画像、表示専用Mermaidとしてrenderされる。
- 一件／一覧／選択comment参照をcopyし、Codex / Claude Codeへ同じ`rvw` Skillを配置してCLIで解決・返信できる。
- Agentは登録済みPRの未解決commentをCLIから発見し、個別取得後に対応できる。
- sync後のreplyをGitHub head commitへ関連付け、UIのpollで更新を表示する。
- force-push前のsource commitを保持し、resetが削除件数を示して明示確認後に再構築する。
- UTF-8、CRLF、binary、large file、symlink、submodule、empty fileを規定どおり扱う。

Quality:

- API/CLI validationとmigrationがあり、Git commandへshell interpolationを使わない。
- `pnpm install --frozen-lockfile`、check、unit/integration、E2E、build、package smokeが成功する。
- Phase 1完了時点のpackageは`name: rvw`かつ`private: true`で、CIからnpm publishしない。
- README、一次仕様、decisions、CLI protocol、3つのbundled Skillが同じ利用者モデルを説明する。

Manual acceptance:

1. 実PRを開き、最新`Pull Request.md`から変更の意図を確認する。
2. 変更fileを入口に全文、all files、検索を使い、関連するdiff外fileまで辿って結果の実装を理解する。
3. Agentが実装説明をWalkthroughとしてpublishし、viewerの表示位置が勝手に変わらないことを確認する。
4. 人間が説明内の一部referenceとdiagram nodeだけを選び、説明tabを残したままexact codeを読む。
5. diff外fileを含む具体的なsourceへline commentを作り、そのURIをAgentへ渡す。
6. Agentが対象sourceと周辺contextを調査し、authorizedな修正、test、commit、push、必要なPR本文更新を行う。
7. Agentが`rvw pr sync --stdin --json`でreplyを追加する。
8. Viewerでnew commitのrepository、任意のcommit range、最新PR本文、comment trackingを読み直してresolveする。

ここまで手動DB編集、内部ID入力、独自の版取り込み操作なしで完了する。

## 17. 変更してはいけない判断

- review version、manual capture、version summaryを再導入しない
- Walkthrough revision履歴、version selector、改訂版の自動複製を追加しない
- PR本文履歴やPR revision selectorを追加しない
- PR本文をcommitへ擬似的にbindingしない
- Ask/AI chat/Agent spawnを追加しない
- arbitrary branch selector、複数Repository Review、Repository ReviewとPull Request Reviewのattachを追加しない
- Issue relation/revision history/cross-repository membership/GitHub Issue writeを追加しない
- Repository Reviewでfix-and-pushやremote writeを許可しない
- Agentにbrowser tabやscroll位置を操作させない
- unresolved/resolved以外のcomment stateを追加しない
- Skill-less fallback、GitHub comment syncを追加しない
- changed filesやdiffだけをrepository readingの境界にしない
- ORM、monorepo、Electron/Tauri、Dockerを導入しない
- live browser stateをAgent protocolへ入れない

変更が本当に必要な場合は、問題、代替案、選択、trade-offを`docs/decisions.md`へ記録する。
