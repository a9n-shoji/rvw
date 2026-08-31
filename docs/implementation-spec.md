# rvw implementation specification

**基準日:** 2026-08-30
**対象:** Phase 1のローカル実用品とPhase 2の配布
**一次仕様:** この文書を実装・テスト・README・Skill契約のsource of truthとする。commitモデルへの
移行は、それと無関係な既存のViewer、comment、CLI、security、配布要件を破棄しない。

## 1. プロダクトの定義

`rvw`は、AIや人間が実装したGitHub Pull Requestを、差分だけでなく変更後のsoftware全体として
人間が理解し、次の実装判断をAgentへ返すためのローカルWeb viewerである。

利用者は最新PRタイトル・本文から変更の意図を読み、PRを構成するGit commitから実装の進行を読み、
変更箇所を入口に選択commit時点のrepository全体へ移動する。コード全文、変更されていないfile、
検索結果を含む任意の文書へコメントでき、その判断をCodex / Claude Codeへ共通Skill経由で受け渡す。
Agentが実装やarchitectureを説明する場合は、source commitをanchorに持つWalkthroughとしてcode reference、
Mermaid図、staticなHTML visualを提示できる。PRに関係するbehaviorをentrypointから周辺relationへ説明する場合は、
同じくexact sourceを持つStructureとしてstableなnodeとedgeを提示できる。どの参照をいつ開くかは人間が選び、
rvwの最大二ペインのdocument workspaceで確認する。

diffは変更を見つけるlensであり、レビュー対象の境界ではない。レビュー対象は選択したcommitが作る
repositoryの状態と、その状態を説明するPull Request全体である。

```text
Pull Request
├─ 最新のPull Request.md
├─ PR commit一覧
├─ 選択範囲のlatest側commitのrepository全体
├─ 選択した連続commit範囲のdiff
├─ Agentが提示したWalkthroughとexact code reference
├─ Agentが提示したStructureとsource-anchored relationship
└─ コメント
```

コード履歴の正本はGit commitである。rvw独自の「レビュー版」は持たず、ユーザーへ
capture、版番号、版説明、版切り替えを要求しない。

人間はsoftwareを理解し、影響を判断し、次の行動を決める。Agentはauthorizedな実装、test、commit、
push、同期を行う。rvwは両者の間にdurableなreading contextとreview recordを提供するが、Agent
runtimeにはならない。説明上の原則は`docs/product-principles.md`にまとめ、この一次仕様と矛盾する
場合は本書を優先する。

## 2. 絶対に守る境界

rvwが担うもの:

- GitHub PRの取得と最新メタデータcache
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
- source commitをanchorに持つAgent Walkthrough、typed code reference、Mermaid図、static HTML visual
- boundedなPR-relevant behaviorをentrypointから表すAgent Structure、stable Node / Edge ID、source anchor
- platform非依存の`rvw` / `rvw-walkthrough` / `rvw-structure` / `rvw-watch-comments` SkillのCodex / Claude Code向けinstall/status

rvwが担わないもの:

- in-app Ask、AI chat、Agent起動、Agent session管理
- コード編集、テスト実行、commit、push、PR編集
- GitHub review commentとの双方向同期
- Skillなしで通じる巨大prompt fallback
- PRタイトル・本文のローカル変更履歴
- PR本文の過去diffやcommitとの時点同期
- semantic search、LSP、独自agent loop
- Agentによるbrowser navigation、tab activation、viewer stateの読み書き
- AgentによるStructure layout座標・focus・viewportの読み書き、AI推論によるedge生成
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
Code
Walkthrough
Structure
Comment
Unresolved / Resolved
```

Git ref、full source OID、comment target、SQLite IDは必要なprotocol以外で露出させない。

`Pull Request.md`は実装が満たそうとする意図、CommitとCommit rangeは実装が変化した順序、Codeは
選択commitが作るsoftware、diffはそのsoftwareで変更された場所を示す。Commentは人間の理解から
生じた質問、修正要求、確認結果をsoftwareの具体的な位置へ結び、Agentとの次の協業単位になる。
WalkthroughはAgentが説明として提示する読み物であり、事実の正本ではない。人間はinline referenceや
diagram nodeから任意のcodeを開き、説明とcommit済みsourceを自分で照合する。同じ参照を横や下へ
列挙するindexは表示しない。Structureはboundedなsubjectの関係を任意方向へ探索するspaceであり、
claimを選択してsource evidenceと照合する。

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
  author,number,url,title,body,createdAt,updatedAt,state,isDraft,\
  baseRefName,baseRefOid,headRefName,headRefOid,\
  headRepository,headRepositoryOwner
```

Phase 1の新規登録は`github.com`のopen/draft PRを対象とする。保存済みPRのsync、refresh、
live確認、resetはClosed/Merged後もGitHub metadataを取得し、最後に成功した`state`と`isDraft`をcacheする。
ローカル表示はPRの現在状態やnetwork接続に依存しない。
`createdAt`と`updatedAt`はGitHub上のPR日時としてcacheする。既存DBで`createdAt`が未取得の行は
ローカル登録日時で補わず`NULL`のまま表示し、次回の通常同期でだけ埋める。一覧表示を契機にGitHubへ
一括問い合わせしない。利用者が一覧の一括更新buttonを押した場合だけ、保存済みPRのうち最後に成功した
syncで`state=OPEN`または状態未取得のPRについて、`state`と`isDraft`をGitHubへ問い合わせてcacheする。
Closed / Mergedは通常の一括更新対象に含めず、個別refresh、`pr sync`、resetで再取得した場合は現在のstateへ
更新する。この操作はcommit、PR title/body、作成／更新日時を同期しない。個別PRの
失敗は成功分の反映を妨げず、対象とerrorを一覧へ返す。GitHub上のDraftは独立stateではなく`state=OPEN`かつ`isDraft=true`なので、
DBでも別々に保持し、一覧ではOpen / Draft / Closed / Mergedの一つへ合成して表示する。既存DBで状態が
未取得の行はbadgeを表示せず、一括status更新または通常同期で取得した際に埋める。

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
  | { kind: "repository-file"; pullRequestId: string; sourceOid: string; path: string };

type DiffDocumentRef = {
  kind: "diff";
  old: DocumentRef | null;
  new: DocumentRef | null;
};
```

repository documentは`sourceOid + path`がexact snapshotである。PR本文はlatest-onlyなので
`pullRequestId`がidentityになる。

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
- focused document paneで`Cmd` / `Ctrl`+`F`を押すと、そのpane右上へVS Code型の検索widgetを重ねる。
  検索対象は現在表示中の文書本文だけとし、tab、viewer control、inline commentは含めない。左右paneはquery、
  option、現在位置を独立して持つ。fixed-string、case-insensitive、部分一致を既定とし、match case、whole word、
  regular expressionを明示toggleできる。入力中に全一致と現在位置を表示・highlightし、前後button、`Enter` /
  `Shift+Enter`、`F3` / `Shift+F3`で末尾と先頭をwrapして移動する。`Escape`で閉じてpaneへfocusを戻し、
  `Cmd` / `Ctrl`+`Shift`+`F`のrepository本文検索とは混同しない。表示中の文書がsame-origin iframeへ登録した
  static visual本文も同じ検索順序・件数・前後移動へ含め、highlightは各child documentのregistryへ描画する。
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
- sidebarのfile、search result、Walkthrough、comment targetと、document pane内のWalkthrough reference、
  diagram node、repository Markdown link、comment内referenceは、通常clickで左pane、`Cmd` / `Ctrl`+clickで右paneへ
  開く。操作元やfocused paneは文書を開く先へ影響させない。tab clickはそのtabが属するpaneをactivateし、
  同一Markdown内の見出しlinkは表示中pane内を移動する。新しい右paneを初めて作る場合も、code
  referenceの選択範囲を描画完了後にviewport中央へfocusする。
- Walkthrough reference、repository Markdownの相対link、comment targetを開いても、repository全体の
  commit範囲、全文／変更、stacked / split、tree modeを変更しない。Walkthrough referenceはclick時に
  `sourceOid + path + line range`から最新`latestHeadOid`へ直接解決し、成功すれば最新commit、失敗すれば
  `sourceOid`を対象にする。全文では対象commitのfull fileを表示する。latest解決後の変更表示は
  `selectedOid === latestHeadOid`の場合だけ、reference解決と独立してtop barのglobalな
  `effectiveOldOid → selectedOid`を使う。global比較がhistorical commitで終わる場合はlatestで解決したpathと
  lineを別revisionへ適用せず、そのpaneだけlatest全文を表示して理由を明示する。anchor fallbackだけは
  参照時点を明示したうえでsource commitの比較を使う。現在の全文／変更とstacked / split設定は切り替えず、
  global比較でfileに差分がなければ通常の`差分なし · 全文表示`を使う。repository Markdownの相対linkとcomment targetはglobal表示が変更でも、
  そのpaneだけretained exact sourceの全文を表示する。Walkthrough referenceのfallbackでは
  `参照時点のコード · <short SHA>`と最新で対応位置を確実に特定できなかったことを明示し、同一pathまたは明確なrename先が
  存在するときだけ、line対応を保証しない`最新のファイルを見る`を提供する。このactionはglobal比較の
  `selectedOid`がtargetのlatest OIDと一致する場合だけ変更表示を使い、historical範囲ではtarget latestの
  exact source全文を開く。anchor commitまたはpathを
  取得できない場合はtabやpaneを開かず、操作元のWalkthroughへ一時chipを表示し、リンク切れと一時的な
  取得失敗を区別する。
- Markdown内の画像はrepository Markdownまたはcomment postから、後述する基準commit内の相対pathを
  参照する場合だけexact commit assetとして自動取得する。PR本文ではmodernな
  `https://github.com/user-attachments/assets/<uuid>`だけをlocalhost endpointへ書き換えて取得する。
  それ以外の外部URL、protocol-relative URL、`data:`、`blob:`、Walkthrough本文、repository pathへ
  安全に解決できない参照はrequestを送らずplaceholderを表示する。画像load errorもalt/titleを保った
  placeholderへ戻す。SVG asset responseは同一originへの直接navigationも含め、scriptと外部subresourceを
  禁止するContent Security Policyとsandboxを付ける。
- sidebarのtop-level stackはExplorerとCommentsの二つにする。Explorerには`Pull Request.md`、
  collapsibleなWalkthrough folder、file名filter、unchanged file表示checkbox、repository treeをこの順に置く。
  本文検索はExplorer headerのactionでSearch viewへ切り替える。ExplorerとSearchは別々のscroll領域へ
  mountしたまま片方だけを表示し、directory、Walkthrough、検索結果の展開状態とscroll位置を保持する。
- tab列は文書navigationだけに使い、review scopeを置かない。review scopeとstacked / splitは
  tabごとに保存しない。
- changed-files tree、tabのchange icon、中央viewerはtop barで選択した同じcommit範囲を使用する。
  sidebar内に別のcomparison selectorを持たない。
- 選択比較で対象fileに変更がなければglobal controlを変えず、そのfileだけdestination commitの
  full textへfallbackして`差分なし · 全文表示`を明示する。`Pull Request.md`も常にfullへfallbackする。
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
- その他menuからbrowser origin（portを含む）単位でAgentコメント通知を明示的に有効化できる。初回のcomment読込は通知せず、
  以後に追加または編集されたpostのうち、最終変更経路が`agent`で、空でない`authorLabel`があり`You`ではないものだけを対象とする。
  `Unknown`と`🔎 確認中です…`は通知せず、watcherが同じpostを最終回答へ編集した時に通知する。
  通知permissionと設定が有効な場合だけBrowser Notificationを作り、クリック時はviewerをfocusする。

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
- browserはGitHub attachment hostへ直接接続せず、PRにscopeしたsame-origin GET endpointを使う。
  endpointは`Sec-Fetch-Site`がある場合に`same-origin`または`none`だけを受理し、`Origin`がある場合は
  viewer originとの一致も検証する。serverは対象PRの存在を確認してから、shellを使わない
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

#### Private PR release前manual smoke

private attachmentをCI fixtureへ保存しないため、release前に次を人間が実施する。

1. private repositoryを閲覧できるaccountで`gh auth status --hostname github.com`が成功することを確認する。
2. そのrepositoryのopen PR本文へ小さなPNGまたはJPEGをpasteし、生成されたmodern
   `https://github.com/user-attachments/assets/<uuid>` URLを本文に残す。比較用に任意の外部画像URLも一件置く。
3. `rvw open <private-pr-url>`でviewerを開き、`Pull Request.md`のPreviewでprivate attachmentが表示され、
   外部画像はalt/title付きplaceholderのままであることを確認する。
4. browser DevToolsのNetworkで、表示画像の`src`とrequest先がlocalhostの
   `/api/pull-requests/:id/github-attachment`であり、browserから`github.com/user-attachments`や外部画像hostへ
   直接requestしていないことを確認する。
5. localhost responseが検出済みのimage Content-Type、`nosniff`、private immutable cache、same-origin CORPを
   持ち、reload後も画像表示とplaceholderが維持されることを確認する。
6. private attachment URL、response body、DevTools traceをrepository、issue、CI logへ保存せず、実施結果だけを
   release checklistへ記録する。

### 5.4 Agent Walkthrough

Walkthroughは、外部AgentがCLIで登録するsource anchor付きMarkdown documentである。rvwは説明を生成せず、
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

- `sourceOid`は対象PRで利用可能なcommitであり、全referenceの`path + line range`が確実に成立した
  元座標と、latest mapping失敗時に本文との対応を保証するfallback snapshotを表す。通常表示commitを
  固定する値ではない。
- publish成功前に`refs/rvw/pr/<number>/commits/oid-<sourceOid>`でobjectを保持する。
- 登録時に各pathがそのcommitで読めるUTF-8 documentであることを検証する。`startLine`と`endLine`は
  両方指定したinclusiveな単行／複数行range、または両方`null`のfile-level referenceとする。
  CLI入力で両方を省略した場合は`null`へ正規化する。line rangeがある場合は文書内に収まることも検証する。
- Markdown内のlink destinationとしてparseされた`rvw-ref:<referenceId>`を登録時に完全一致で検証し、
  typed reference buttonとして表示する。code blockやinline code内の文字列はlinkとして扱わない。
- 全reference IDはMarkdownまたはHTML内の`rvw-ref:` link、または`diagramBindings`のvalueとして最低一度使う。
  binding keyは本文中のflowchart node、class diagram class、sequence participant / actor、state、ER entity、
  architecture serviceのいずれかとして実在するsource IDであることも検証する。message、transition、relationship、
  architecture edge / groupはbinding対象にしない。`diagramBindings`はWalkthrough全体へ適用し、複数のMermaid
  fenceで同じsource IDを使った場合はすべて同じreferenceへbindする。別referenceが必要ならsource IDを分ける。
  存在しないnode-like elementへのbindingを含め、どちらからも実際に到達できないreferenceは、重複indexのないviewerでは
  開けないため登録を拒否する。
- sidebar一覧はtitle、current source OID、author、reference件数だけを返し、現在の本文・参照・diagram
  bindingは人間がWalkthrough tabを開いた時に取得する。CLI更新をpollで検出した場合は、開いているtabも
  同じIDの最新内容とtitleへ結び直す。Explorerの一行表示はtitleを主表示とし、authorと短縮source OIDは
  native tooltipで確認できるようにする。
- Walkthrough tabは本文中のtyped inline referenceとbinding済みMermaid nodeを維持するが、横または下に
  全referenceを重複表示する`Code references` indexは持たない。sidebar itemにもreference件数を表示しない。
- `language-mermaid` code blockはstrict security設定でSVG化する。bundled Mermaidが扱うflowchart、
  class、sequence、state、ERなどの記法を描画対象とする。binding済み要素だけを人間が選べる。
  interactive bindingはflowchart node、class diagram class、sequence participant / actor、stateDiagram-v2 state、
  erDiagram entity、architecture-beta serviceをE2E保証する。Mermaid SVGのdiagram固有DOM解釈はUI interactionから
  分離したresolverへ集約し、source IDがSVGへ保持されない複製要素をlabelやDOM順序で推測しない。
  binding済み要素はdiagram種別にかかわらずaccent枠、
  薄いaccent背景、hover / focus強調を共通のaffordanceとして表示する。
- exact `html-preview` fenced blockは、Markdown正本の一部としてstaticなHTML fragmentをvisual explanationへ
  描画する。通常の`html` fenceはcode表示のままとする。Walkthrough本文全体を一つの`html-preview`中心で
  構成することも許容するが、HTML用domain model、DB row、別revisionは追加せず、current Markdown本文と
  そのinclusive source lineだけを正本にする。
- `html-preview`はpublish / update時にHTML、inline CSS、inline SVGをparse、allowlist検証、sanitizeし、
  source line情報を付けてからsame-origin sandbox iframeへ`srcdoc`として渡す。Agent authored script、event
  handler、frame、form送信、network、font、media、worker、外部resourceは実行・取得させず、sandboxへ
  `allow-scripts`を付けない。CSPを最終防衛線としてscriptと全networkを拒否する。
- HTML visual内の`rvw-ref:<referenceId>`はMarkdown linkと同じreference lifecycleへ統合し、人間が選んだ
  時だけ同じlatest/fallback解決でcodeを開く。repository相対画像はWalkthroughのexact `sourceOid`からparent documentが取得し、
  許可された画像data URLへ変換してiframeへ渡す。外部画像、stylesheet、その他の外部resourceは拒否する。
- HTML要素とtext selectionは生成DOM identityを保存せず、parser由来のWalkthrough source line rangeへ戻す。
  新規comment composerは選択したtextまたはvisualの近くへparent overlayとして表示し、既存commentはvisual
  markerからcanonicalなComments sidebar threadをactivateする。HTML内部rangeのthreadを外側Markdown blockの
  inline threadとして重複表示しない。overlay actionはiframeからparent overlayへpointerを移動しても維持し、
  markerはiframe内部scrollにも追従する。本文更新後のmappingとOutdatedは通常のWalkthrough line comment規則に従う。
- same-origin iframe documentはPane Findの検索・highlight対象へ登録し、iframe内にfocusがある時の
  Cmd/Ctrl+F、Cmd/Ctrl+P、Cmd/Ctrl+Shift+Fをparentの同じglobal shortcutへrelayする。
- 人間がreferenceを選んだ時だけ、`sourceOid + path + line range`を最新`latestHeadOid`へ一度だけ直接
  mappingする。file全体が同一なら元の座標を維持し、fileが異なる場合は同一codeとして変更されず、連続し、
  sourceとlatestの双方で一意に追跡できるrange、または存在するfile-level
  referenceだけを成功とする。file-level referenceもlatest documentが`available`の場合だけ成功とし、
  binary、too-large、missingは表示可能なanchorへfallbackする。元pathがlatestにも存在すればそのpathを維持する。
  元pathが消えた場合だけ`git diff --find-renames --find-copies --find-copies-harder`を1回実行し、anchor path由来の
  rename/copy候補がちょうど1件なら新pathへ追従する。複数候補はGitが1件をrenameとして選んでも曖昧とする。
  変更、重複候補、削除、読取不能など確実でない場合は推測せず`sourceOid`へfallbackし、途中commitや
  「成立していた最後のcommit」を探索しない。このnavigationはglobalなcommit範囲と表示controlを変更しない。
  anchor sourceのcommitまたはpathがmissingならtabを開かず一時chipでリンク切れを示し、通信や一時的な
  取得失敗はリンク切れと区別する。解決したline rangeは範囲全体を強調し、file-level referenceでは行を
  選択しない。解決結果と`sourceOid + path + line range`のcanonical fingerprintは閲覧時の一時状態であり、
  DBへlatest/resolved OID、version、flagを保存しない。解決後にPR headが進んだtabは旧headを無言で最新扱いせず、`解決時 <old> → 現在 <new>`と
  `最新へ再解決`を表示する。staleなsource fallbackでは表示中のanchor OIDだけを残し、旧headに対する
  fallback判断と`最新のファイルを見る`を隠す。同じWalkthrough IDのreference fingerprintが変わった場合も
  `Walkthroughが更新されています`としてstaleにする。stale理由は専用bannerへ集約し、historical range用noticeは表示しない。
  初期実装では閲覧位置を自動で置換せず、人間がactionを選んだ時だけ同じreference IDを再解決する。
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
  retained Git commit refは個別削除せずresetまで保持する。
- 通常のraw HTMLとscriptは実行しない。検証済みのexact `html-preview` fragmentだけを上記sandboxで表示する。
  本文は256 KiB、referenceは200件を上限とする。
- Phase 1は作成、閲覧、同一ID更新、確認付き削除を扱い、更新履歴、AI chat、自動navigationは扱わない。

## 5.5 Structure

StructureはPRに関係するboundedなbehaviorを、source-establishedなentrypointから依存、contract、side effectへ
任意の方向に探索できるrelationship spaceとして表す。Walkthroughは意図的な読解pathであり、Structureは
読解順を規定しない。flowをgraphへ押し込まず、順番が理解の本体ならWalkthroughを使う。entrypointを持たない
静的なarchitecture／責務inventoryはPR reviewの停止条件を失うためStructureの対象にしない。Structureは
generic Artifact system、semantic code graph、AI推論結果、review finding、completeness保証ではない。

一つのStructureは次を持つ。

```ts
type SourceAnchor = {
  path: string;
  startLine: number | null;
  endLine: number | null;
};

type StructureNode = {
  id: string;
  label: string;
  description: string | null;
  kind: string | null; // deprecated compatibility input; viewerは表示しない
  notation: "plain" | "class" | "database" | "interface" | "component" | "external" | "concept";
  anchor: SourceAnchor | null;
};

type StructureEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  directed: boolean;
  anchors: SourceAnchor[];
};

type Structure = {
  id: string;
  ref: `rvw://structure/${string}`;
  pullRequestId: string;
  sourceOid: string;
  title: string;
  scope: string;
  originNodeId: string;
  nodes: StructureNode[];
  edges: StructureEdge[];
  createdAt: string;
  updatedAt: string;
};
```

- `title`と`scope`はsubjectとboundaryを宣言する。producerはuser / caller / PR本文の明示指示を優先し、
  commit済みcodeとtestで未指定部分だけを補う。
- Node / Edge IDは`^[A-Za-z][A-Za-z0-9_-]{0,63}$`を満たすlabelとは別のclaim identityであり、
  Structure内でuniqueとする。same-subject updateで
  surviving claimのIDを維持し、削除したIDを別claimへ再利用しない。削除済みNode / Edge IDは小さな
  tombstoneとして保持し、current graphへ再導入するupdateを拒否する。別subjectは新しいStructureにする。
- Nodeは0または1件、Edgeは0件以上かつ20件以下のanchorを持つ。全anchorは一つの`sourceOid`で検証し、
  repository-relative UTF-8 text pathと、両方nullまたは両方positiveなinclusive line pairだけを受け付ける。
  Structure全体ではsource anchorを1件以上400件以下とする。
- Node 1件以上50件以下、Edge 200件以下、payload 2 MiB以下とする。endpointと`originNodeId`は実在Nodeを
  指し、origin Node自身はsource anchorを持つ。Edge direction、parallel multiplicity、self-loopを無視した
  simple graphで全Nodeがoriginから到達可能でなければならない。parallel Edgeはそれぞれstable IDを持ち、
  `directed`は必須booleanである。
- `originNodeId`は対象behaviorを検証し始めるsource-establishedなentrypointを指す。
  HTTP routeに限らずpublic API、command handler、worker trigger、event subscriber、composition call、
  migration execution pointを含む。同一subjectの実装上のentrypointが移動した場合だけupdateで変更できる。
- Node descriptionとEdge labelはproducer claimであり、source anchorはそのclaimを検証する根拠である。
  Edge labelは`from`をactor/source、`to`をtargetとして自然に読めるverb / verb phraseを使い、
  directionを読解順には使わない。配置を操作するためにinverse relationやactive/passive表現を選ばない。
- `kind`は既存producerとの互換性のため入力とcurrent valueに残すdeprecated fieldであり、viewerは表示せず、
  新しいproducerは省略する。`notation`は`plain | class | database | interface | component | external | concept`の
  controlledな任意表示で、未指定は`plain`とする。producerが明示し、viewerは`kind`やpathから推論せず、
  layoutにも使わない。comment、group、
  reverse lookup、durable layout、confidence、severityは持たない。
- SQLiteはstable identityと一つのcurrent graph値だけを保持する。updateは`expectedUpdatedAt`を条件にした
  atomicなwhole-value replacementで、node/edge単位patch、過去値、Structure revision、version selectorを
  持たない。deleteもpreviewで読んだ`updatedAt`がcurrent値と一致する場合だけ実行する。

viewerはStructureをPR / repository file / Walkthroughと同じfirst-class document tabとして扱う。Structure
folderには同じPRの複数Structureを並べる。開いた時点でcode tabを増やさず、人間がNodeまたはEdgeのsource
actionを選んだ時だけ、Structureの`sourceOid + path + line range`から最新`latestHeadOid`へ直接mappingする。
変更されていない一意なrangeまたはfile-level anchorは最新commitへ開き、mapping不能時はStructureのexact
`sourceOid`へ保守的にfallbackする。PR全体または最新commitを選択中なら、latest解決したfileは現在のglobal
比較範囲で表示する。historical rangeではlatestのexact全文、source fallbackではanchor commitを表示する。
`Cmd` / `Ctrl`+clickは右ペインへ開き、global commit range、表示mode、Structure focusを変更しない。

探索はfocus、1-hop / 2-hop / All、pan、zoom、fit、focus center、node dragを提供する。trackpadの通常wheelは
pan、pinchに相当するCtrl / Meta付きwheelはpointer位置を中心とするzoomとして扱う。layoutはtopology、
factualなEdge direction、`originNodeId` entrypoint、stable IDを入力とするdeterministicなbehavior projectionと
する。entrypointからdirected relationで到達できるunambiguousなEdge pairを左から右のrankへ置き、分岐は
vertical whitespaceとtopology由来の順序で並べる。このrankは処理順や推奨読解順のproducer claimではなく、
viewerがfactualなoriginとrelation directionから導出するprojectionである。undirected／reciprocal Edge、
relation、parallel Edge数、self relationは方向軸へ影響させない。label、kind、description、path、変更種別も
位置決定へ使わない。stable IDは対称な配置を決定するtie-breakerに限り、rootを選ばない。producer指定の
座標やpresentation hintは受け取らない。

base mapはcurrent Structureだけから決定的に導出するcanonical layoutで、新しいsessionと明示的なlayout resetに
使う。session layoutはそれを起点にした人間のreading stateであり、Node dragとwhole-value update後もretained
Nodeの位置を維持する。削除後の空間を自動で詰めたり、filterやfocus変更でreflowしたりしない。新規Nodeは
retained neighborの重心を起点に全方向の空き候補を調べ、既存のmental mapを壊さず発見できる位置へ置く。
Node位置、focus、
depth、viewportはbrowser session内だけでpaneとStructure IDの組へ保持し、tab往復とcurrent-value更新後も
surviving IDの位置を保つ。layout resetはNode座標だけをcanonical値へ戻し、reviewerのpan / zoomは維持する。
左右paneで同じStructureを
開いてもreading stateとDOM参照を共有しない。reload、別browser、CLI、SQLiteへ座標を持ち越さない。drag後は
canonical layoutへ戻せる。
`originNodeId`は新しいreading sessionの初期highlight、orientation、canonical behavior projectionのentrypointに
使い、初期depthはAllとする。
current-value更新でfocus Nodeが消えた場合は、
producerの新しい`originNodeId`へ移動せずfocusなしのAllへ戻す。人間は明示buttonまたはEscapeでfocusを解除できる。
新しいsessionは全Node / Edgeを描画しながら`originNodeId`を等倍でcanvas幅の25%付近、縦中央へ置き、
右方向へ広がる読み取り空間を確保して全体を自動fitしない。
focusがない場合もbase map中央を等倍で示す。1-hop / 2-hop / Allの切り替えはNode座標とcameraを変えず、
表示するsubgraphだけを変更する。局所へ絞る時も読みやすい倍率とorientationを失わず、Allへ戻れば同じcameraで
全体へ位置付け直せる。表示中のgraphを一枚へ圧縮するのは「表示中を収める」という明示操作だけとする。
Fitとtoolbar / wheel zoomは同じminimum scaleを使い、縮小操作がscaleを増加させない。
poll updateもNode位置とviewportを維持し、自動fitしない。

directed EdgeはNode外周より外で始点／終点を止め、arrowheadをNodeの下へ隠さない緩いBézier曲線で描く。
parallel / reciprocal Edgeはstable IDでlaneを分ける。focusがある時はdepthによらずfocused Nodeのincident Edge
（および選択中のEdge）、focusなしでは表示中の全Edge labelをNodeと既存labelを避けて配置し、
Edge labelは実際のBézier曲線付近へ置く。Edge labelを選ぶと対応する線と両端Nodeを強調する。
relation labelの右にNodeと同型のexact source actionを置く。anchorが1件なら直接開き、複数ならlabel付近の
compact chooserから全source evidenceを選べる。Relation上へsource file名は常時表示しない。
Nodeはsource file identityをclaim titleと別の行に置き、source actionを右上の先頭行へ分ける。Nodeは固定cardの
大きさを変えず、titleとdescriptionを省略しない。内容がcardを超える場合はNode内を縦scrollして全文を確認でき、
descriptionの本文領域はsource actionの下も含めて右端まで使う。Node内scrollはlayout座標、Edge route、session座標、
canvas zoomを変更しない。
canvasはfocus名、可視／全体件数、
zoom率とminimapを常時提示する。zoomは同じcardとRelation labelを一体として拡大縮小し、表示情報を暗黙に
増減させない。広域の位置関係はminimap、局所の読解はpan / zoom、全体把握は明示的なfitで使い分ける。
Structure固有のheaderはtitleとexact sourceを一つのcompact rowへ置き、scopeは同じrowから開くnon-modalな
popoverで確認できるようにする。表示操作はcanvas上のsingle-row overlayとし、狭いpaneでも複数行へwrapして
canvasの縦幅を奪わず、水平方向にscrollして全操作へ到達できるようにする。

1-hop / 2-hopはfocusがある時だけ選べる。focusなしはAllへ戻し、Allは全Nodeと全Edgeを表示する。relationを
stable IDや件数で自動的に隠さない。bounded graphを超えるsubjectはproducerがscopeを分ける。別のoriginから
独立してtriggerされるbehaviorへ到達した時点も分割境界とし、静的なsubsystem inventoryへ拡張しない。選択commit範囲に対する変更file
presentationはbadge / borderだけへ反映し、source identityとlayoutへ影響させない。

publish / update / deleteはpassiveでbrowserを開かずnavigationを変更しない。publishは一つのlogical operationに
保持する`idempotencyKey`を必須とし、同じcanonical payloadの再送は元のstable URIを返す。別payloadへのkey再利用と
個別削除済みresultの再生成は拒否する。`pr reset`は対象PRのStructure publication recordも削除し、同じkeyによる
新しいpublicationを許可する。`structure list`はPRごとのstable URIを含むsummaryを返す。viewerはpollで
listとcurrent valueを更新し、stable IDでsession空間をreconcileする。open viewerには更新を明示しながら
閲覧状態を維持する。削除は対象StructureとNode / Edge / anchor件数を確認
したhuman action、または同じpreviewを読んだAgentへの明示authorization後だけ実行する。retained commit refは
共有され得るため個別deleteでは外さず、PR resetをcleanup boundaryとする。

## 6. コメントモデル

コメント対象:

1. PR全体
2. 最新Pull Request.md全体
3. 最新Pull Request.md行範囲
4. exact commitのコードファイル全体
5. exact commitのコード行範囲
6. diffのold/newいずれかのexact document
7. stable IDを持つWalkthrough全体またはMarkdown source行範囲

```typescript
type CommentTarget =
  | { kind: "pull-request" }
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
watch taskはbatchをclaimし、対象threadの存在を確認した直後に通常replyとして`🔎 確認中です…`を一件
作成する。task-local DBはbatch内のcomment URIごとに冪等keyとstatus post IDを保持し、同じbatchのretryだけで
そのpostを再利用する。同じthreadへの後続replyを別batchで処理するときは新しいstatus postを作成し、過去の
回答を変更しない。調査または作業の完了、terminal failureでは現在のbatchの同じpost本文を一つの最終結果へ
編集し、新しい完了replyを追加しない。このstatus postは専用comment stateではなく通常postであり、threadの
unresolved/resolved状態を変えない。
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
rvw walkthrough delete <WALKTHROUGH_URI> --yes --json
rvw structure get <STRUCTURE_URI> --json
rvw structure list <PR_REF> --json
rvw structure publish --stdin --json
rvw structure update <STRUCTURE_URI> --stdin --json
rvw structure delete <STRUCTURE_URI> --json
rvw structure delete <STRUCTURE_URI> --yes --expected-updated-at <PREVIEW_UPDATED_AT> --json
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
structure.list
structure.read
structure.publish
structure.update
structure.delete
walkthrough.read
walkthrough.publish
walkthrough.update
walkthrough.delete
walkthrough.htmlPreview
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
fingerprintへ含めない。keyのreuseは拒否し、元postが削除済みなら再作成せず明示errorにする。

### 7.3 comment watch

`rvw comment watch --json-seq`は保存済み全PRの新規root commentとreplyをRFC 7464 JSON text
sequenceとして出力する。cursor省略時は現在の最新event位置へanchorし、起動前の既存未解決commentを
処理しない。最初の`ready` frameがdatabase-scoped opaque cursorを返し、その後の`comment-posted` frameは
各event直後のcursor、sequence、post ID、comment URI、PR URL、削除済みかを返す。eventは調査contextを
含まない最小triggerとし、Agentは必ず`comment get`でthreadを読み直す。

`--after`は同じdatabaseのcursorから再生し、別database、最新sequenceより先、破損、未知versionのcursorを拒否する。poll間隔は
既定10秒、1〜300秒とする。event rowはcomment/post削除と独立して保持し、削除後の再生は`deleted: true`
として返す。複数の独立taskは別cursorで同じlogを読める。

cursor、pending queue、retry、authorization、Agentが作成したpost IDは外部Agent taskがrepository外へ
保持する。同梱Skillのstate scriptはtask専用SQLiteを使い、event enqueueとcursor更新、batch lease、retry、
batch内のcomment URIごとのstatus post mapping、自己post抑制をtransaction化する。batch claim直後にthreadを
確認して冪等なack replyを即時作成する。最初のauto-ack claimはack投稿より前に、表示用Agent名または
意図的な無名をtaskのimmutable metaへ固定する。再開時は同じ値だけを使い、異なる指定はrvwへのread/write前に
拒否する。同じbatchのretryでstatus postがあればそのpostをack本文へ戻すが、
後続replyの新しいbatchは新しいpostを作る。完了時は現在のbatchのpostを最終結果へ編集する。同梱preflightは
protocol、capability、transport、Nodeを一括検査し、watch driverは
stateのcursorを自動解決してRFC 7464 frameをatomicにingestする。driverのauto-ack modeは新規batchを
LLM往復なしにclaim、thread再読込、ack投稿まで進め、leaseとthread contextを一行JSONで通知する。
親taskは起動前にsubagent slot数を予約する。`max-in-flight`は8を目標とし、runtimeが8枠を保証できれば8、
それ未満なら保証できる最大の正数、複数枠を保証できなければ1を指定し、予約数を超えない。driverはlimit
未満だけauto-ackし、task stateを短周期で再確認する。investigate-and-replyだけを許可したtaskでは、同一PRの
active lease中に到着したeventも別batchとしてcapacity内でauto-ackし、同じPRまたはrepositoryをread-onlyで
並列調査できる。batchごとのstatus postを使うため最終reply editは衝突しない。fix-and-pushを許可したtaskでは
同一PRの後続eventを先行lease解放後まで待たせ、repository write reservationにより異なるPR間のwriterも直列化
する。retryable failureは`nextAttemptAt`到達後に、新しいwatch eventやreconnectを待たずauto-ackする。
state toolはpending集合のemptyからnon-emptyへの遷移を一行JSONで待機できる。rvwはAgentやsubagentを
起動せず、これらのtask stateも保持しない。
task起動時に明示された場合だけ、live PR authorと起動時GitHub loginが一致し、live head repository、branch、
OIDとpush先が一致するPRをfix-and-push候補にできる。他人、不明、不一致はinvestigate-and-replyとする。
親taskはacknowledge済みleaseをbatchの大きさ、mode、変更有無にかかわらず同じscheduling turn内で一つの
fresh subagentへ必ず委譲し、直接調査・実装しない。subagentを速やかに起動できない場合はleaseをretryable
failureへ戻し、親taskが代行しない。subagent結果は、最終bodyに加えて`relatedCommitOid`、完全な
`references`配列、`pushStatus`を持つ。
code変更がない調査結果でも、具体的なcode上の結論を支える利用可能なPR commitとtyped referenceを返せる。
parentはthreadを再取得してbody、commit、referenceを検証し、同じstatus postの完全置換へすべて渡す。
fix-and-push後のreferenceは同期済みGitHub headへ固定する。referenceがない結果は空配列を明示し、以前の
retryやacknowledgementから宣言を引き継がない。

### 7.4 Walkthrough lifecycle

既存Walkthroughはstable URIから現在内容と対象PRを取得できる。

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

`pullRequest`と`sourceOid`、title、body、1件以上のreferenceは必須である。CLIはcommit、path、
任意のline range、Markdown reference、実在する対応済みMermaid node-like elementへのdiagram bindingを検証し、本文linkまたはdiagram bindingから
一度も参照されないreferenceを拒否してから、一つのSQLite transactionで保存してchange sequenceを
更新する。成功responseは`rvw://walkthrough/<uuid>`を含むWalkthrough全体を返す。
このcommandはbrowserを開かず、どのviewerのnavigationも変更しない。

#### Update

```bash
rvw walkthrough update <WALKTHROUGH_URI> --stdin --json
```

stdinはpublish inputから`pullRequest`を除いた完全置換objectであり、`sourceOid`、title、body、全referenceを
必須とする。`diagramBindings`省略時は空、`authorLabel`省略時だけ既存値を保つ。publishと同じ検証後、
同じWalkthrough IDとURI、`createdAt`を保って現在値を一つのSQLite transactionで置き換え、change
sequenceを更新する。過去値は保存しない。既存の文書全体commentは同じIDへ残る。publishとupdateは
passiveであり、browserを開かずnavigationも変更しない。

#### Delete

```bash
rvw walkthrough delete <WALKTHROUGH_URI> --json
rvw walkthrough delete <WALKTHROUGH_URI> --yes --json
```

`--yes`なしは`WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED`と対象Walkthrough、reference、comment、postの
削除件数を返してexit 2とする。明示authorization後の`--yes`だけがWalkthrough、reference、対象comment、
postを一つのSQLite transactionで物理削除し、change sequenceを更新する。この削除はretained commit refを
削除しない。

### 7.5 Structure lifecycle

```bash
rvw structure get <STRUCTURE_URI> --json
rvw structure list <PR_REF> --json
rvw structure publish --stdin --json
rvw structure update <STRUCTURE_URI> --stdin --json
rvw structure delete <STRUCTURE_URI> --json
rvw structure delete <STRUCTURE_URI> --yes --expected-updated-at <PREVIEW_UPDATED_AT> --json
```

publish inputは`idempotencyKey`、`pullRequest`、`sourceOid`、`title`、`scope`、requiredな`originNodeId`、全
`nodes`、全`edges`を持つ。同じkeyとcanonical payloadの再送は元のStructureを返し、別payloadとのkey conflictと
削除済みresultを明示errorにする。`list`はPR selectorからstable `ref`を含むsummaryを返す。updateは
`expectedUpdatedAt`と`pullRequest`を除く同じcurrent値の完全置換である。CLIとAgent socketは同じschemaと
application validationを使用し、commit availability、PR ownership、UTF-8 document、line pair、ID、endpoint、
focus、anchor総数、count、byte上限を検証する。publish成功は新しいstable `rvw://structure/<uuid>`、update成功は同じID / URI /
`createdAt`と新しい`updatedAt`を返す。updateはcurrent `updatedAt`がexpected値と一致する時だけ保存し、不一致は
409の`STRUCTURE_CONFLICT`を返す。どちらもretained commit refを確保してから一つのSQLite transactionで保存し、
失敗時はref作成をrollbackする。過去graphは保存しないが、削除済みNode / Edge IDのtombstoneは保持して
stable identityの再利用を拒否する。

`get`はcurrent Structureと対象PR identity、local repository pathを返す。`--yes`なしのdeleteは
`STRUCTURE_DELETE_CONFIRMATION_REQUIRED`、current Structure、Node / Edge / anchor件数を返してexit 2とする。
confirmed deleteはpreviewの`updatedAt`を必須とし、current値が変わっていない場合だけ物理削除する。全commandは
passiveでviewerを操作しない。

### 7.6 JSON transport contract

- machine consumerは`--json`または`--stdin --json`を必須とし、stdoutへJSON valueを一つだけ返す。
- 長時間の`comment watch`だけは`--json-seq`を必須とし、stdoutへRFC 7464 frameを複数返す。
- progressとdiagnosticはstderrへ出し、errorは`code`、`message`、`suggestions`を持つ。
- stdinは40 MiB以下の単一JSON objectとし、EOFを受けてからparseする。改行だけでは入力を終了しない。
  process callerはJSON送信後にstdinをcloseし、shell callerはpipe、quoted heredoc、input redirectionの
  いずれかを使って対話PTYでのEOF待ちを避ける。Agent socket frameはこの入力とprotocol envelopeを
  収める固定上限を持つ。
- comment本文とreplyはUTF-8 GFM Markdown sourceで64 KiB以下とする。comment postとWalkthroughの
  referenceはそれぞれ最大200件とする。
- `walkthrough get`はcurrent WalkthroughとPR identity、local repository pathを返す。
- `structure get`はcurrent StructureとPR identity、local repository pathを返す。
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
  capabilityを追加する。いずれもCLI contract test、4つの共通Skill、README、`docs/cli-protocol.md`を
  同じ変更で更新する。

## 8. SQLite

OS user data directoryに一つのDBを置く。`node:sqlite`、WAL、foreign keys、busy timeoutを使う。
既定DB directory/fileは新規作成時だけ`0700` / `0600`へchmodする。既存pathはstatでmodeとownerを検証し、
安全ならchmodしない。新規pathへのchmodが`EPERM`でもstat結果が安全なら継続し、安全でない場合だけpath、
実値、期待値を含む明示errorにする。`RVW_DATABASE_PATH`を設定したDBは呼び出し側管理として既存pathを
chmodしない。rvwが不足directory/fileを新規作成する場合はchmodではなく作成modeで`0700` / `0600`にし、
既存pathのmode/ownerと推奨値との差は`doctor --json`へwarningとして出す。

通常権限のviewer runtimeは`0700`のuser専用一時directory内へdatabase別Unix socket（`0600`）を
提供する。同じdatabase pathでは一つのruntime processだけを許し、別の`RVW_DATABASE_PATH`は独立した
runtimeを持てる。通常の`rvw open`はこのsocketの内部`viewer.open`操作でactive runtimeを発見し、
requested PRを同じHTTP originへ追加してURLを受け取る。これは公開Agent command / capabilityではない。
Agent CLIはDBを直接開く前に
socketへ同じapplication service操作を依頼する。`RVW_AGENT_SOCKET_PATH`未指定時はrequest送信前の接続失敗
だけ従来のdirect CLIへfallbackできる。明示時はそのsocketを必須とし、接続失敗またはDB不一致を
`AGENT_SOCKET_UNAVAILABLE`として返してdirect DBを開かない。全socket requestは期待DB pathを含め、viewerの
DBと一致する場合だけdispatchする。接続成立後にrequestを送信した操作はtimeout、切断、不正responseでも
direct実行へfallbackせず、結果不明の明示errorを返す。破壊操作の確認はCLIだけでなくsocket dispatchでも
検証する。

`rvw agent ping/status --json`はsocket path、接続結果、OS接続error詳細、期待／接続先DB、owner PID、選択
transport、fallback理由をmachine-readableに返し、人向け出力にも同じ診断項目を表示する。同じsocket
pathのlisten前にatomicなowner lockを取得し、その所有権をRuntime / SQLite / HTTP serverの初期化より先に
確定する。競合に負けた`rvw open` workerはこれらを初期化せず、稼働中のownerの`viewer.open`へ委譲する。
ownerが停止中でsocket受付を終えている、または`viewer.open`が停止中を返した場合は、owner lock解放後に
ownership取得を再試行する。複数workerが再試行してもlockのwinnerだけがRuntimeを初期化する。
終了時はowner lockをRuntime全体の寿命まで保持し、Agent requestの受付停止、HTTP serverのdrain、
Runtime / SQLiteのclose、socket cleanup、owner lock解放の順に処理する。受付を止めた後もlockを解放するまでは
同じdatabaseの新しいRuntimeを作らない。
lockのowner PIDが生存中またはlockが安全に読めない間はtakeoverせず、owner終了後の新しい起動だけがexact
inodeを確認してstale lock/socketを除去する。`doctor --json`はDBの
mode/ownerに加えてrollbackするwrite transactionとAgent疎通を実行・報告する。

```sql
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- change_sequence、global theme_preference、comment_watch_database_idを保持する。

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
  github_created_at TEXT,
  github_updated_at TEXT NOT NULL,
  github_state TEXT CHECK(github_state IN ('OPEN', 'CLOSED', 'MERGED')),
  github_is_draft INTEGER CHECK(github_is_draft IN (0, 1)),
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

CREATE TABLE structures (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  source_oid TEXT NOT NULL,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE structure_publish_idempotency (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  structure_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

commit table、review version table、PR revision tableは持たない。既存Phase 1 DBはmigrationで
version参照をcommit OIDへ移し、旧PR本文コメントはquoteが復元できない場合Outdatedとして残す。
既存の`refs/rvw/pr/<n>/version/...`は旧comment source objectを失わないようresetまで保持し、
以後の同期だけがcommit ref形式を使う。

## 9. Application / API

主なHTTP API:

```text
GET  /api/pull-requests?offset=<offset>&limit=<limit>&hideClosedOrMerged=<bool>
POST /api/pull-requests/refresh-statuses
GET  /api/pull-requests/:id
POST /api/pull-requests/open
POST /api/pull-requests/:id/refresh
POST /api/pull-requests/:id/reset

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
GET /api/pull-requests/:id/walkthroughs/:walkthroughId/references/:referenceId/resolve
DELETE /api/pull-requests/:id/walkthroughs/:walkthroughId
GET /api/pull-requests/:id/structures
GET /api/pull-requests/:id/structures/:structureId
DELETE /api/pull-requests/:id/structures/:structureId

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
Pull Request一覧APIは既定50件・最大100件のoffset paginationとし、`total`、`hasMore`、`nextOffset`を返す。
`hideClosedOrMerged`は既定`true`で、最後に成功したsyncで保存した`github_state`がClosedまたはMergedの行だけを
pagination前に除外する。Open、Draft、および状態未取得のlegacy行は表示し、`false`では全件を返す。
一覧表示を理由にGitHubへ通信しない。一括status更新は明示的なPOSTだけで実行し、`github_state = 'OPEN' OR
github_state IS NULL`の保存済みPRだけを最大4件並列で取得する。対象がなければGitHub認証も行わない。
成功したstatusは一つのSQLite transactionで反映し、部分失敗を結果へ含める。`attempted`、`updated`、
`failures`は全登録件数ではなく、この同期対象についての件数と結果を表す。
各行はPR identity、title、GitHubの作成／更新日時、未解決／解決済みcomment数、Walkthrough数、Structure数だけを持つ
SQLite専用read modelとする。Git commitを読む`getPullRequestView()`は呼ばず、先に一覧1ページを絞ってから
その行だけのcountをaggregate queryで取得し、PRごとのN+1 queryを作らない。順序は
`github_updated_at DESC`の後に永続IDを
tie-breakerとして固定する。

## 10. Viewer UX

URLに`pullRequestId`がない場合はuser-global SQLiteへ登録済みのPull Request一覧をworkspace入口として表示する。
一覧は`owner/repository`、PR番号、title、未解決／解決済みcomment数、Walkthrough数、Structure数、GitHub上の作成／更新日時を
一行にまとめ、未解決comment数は`unresolved`と表示する。PR titleは省略せず、必要な高さまで複数行に
折り返して全文を表示する。GitHub更新日時の新しい順であることを明示し、
Closed / Mergedを非表示にするcheckboxは既定ONとする。状態未取得のlegacy行はbadgeなしで表示する。
Openまたは状態未取得の登録済みPRのcached statusを明示的に更新するbuttonをfilterの隣へ置き、実行中、成功件数、失敗件数と
失敗対象を表示する。画面表示やfilter変更だけではGitHubへ問い合わせない。一括更新で現在のpagination
offsetが範囲外になった場合だけ、最後の有効pageへ移動する。
filter後の0件は解除方法を示し、全件表示でも0件なら
`rvw open <PR URL>`を案内するempty stateとし、
未取得の作成日時は不明と表示する。filter値はURLへ追加せず、reloadでは既定ONへ戻す。行選択とviewerの
rvw brandはHistory APIで一覧と対象viewerを往復し、
browser Back / Forwardを保つ。新しいrouterや永続workspace stateは導入しない。
viewerのrvw brandは一覧への実linkとし、通常clickは既存のHistory API遷移、Cmd/Ctrl+clickや
middle clickはbrowser標準の別tab遷移を使う。
一覧からBack / Forwardで既存viewer entryへ戻る場合は、そのentryが持つfocused documentと位置も通常の
reading historyとして復元する。reloadまたは新しい一覧行選択は従来どおり新しい一時workspaceを開始する。

Viewerの最優先目的は、選択commitが作るrepositoryの状態を利用者が見失わずに読み進めることである。
初期表示は全文とし、変更fileとdiffはrepository readingを開始するindexとして扱う。利用者が
関連file、test、設定、documentへ移動してもcommit範囲とopen documentを維持し、diff外へ出たことを
理由にreview contextを作り直させない。

最上部のtop barにPR情報と、repository全体へ作用するcommit範囲、表示、diff styleを並べる。
同期とreset actionは右端の`...` menuへ格納し、通常時の縦幅を増やさない。
各paneのtab列はPR、repository file、Walkthrough、Structureの文書navigationだけに使う。

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
最新HEAD上の対応箇所、またはmapping不能時のanchor source tabへ移動し、説明tabと既に開いているcode tabはworking setとして残す。必要なら最大二つの
横ペインへtabを移動し、Walkthroughとsource、二つのsource、Markdown previewとcodeを並べて読む。
reference tabを開く操作はglobalな対象commit範囲や表示modeを変更せず、参照anchorを取得できない場合は
tabを開かずWalkthrough上の一時chipで通知する。fallback時はanchor表示であることと、利用可能なら
line保証のない最新fileへのactionをpane内で明示する。
CLIによる同一ID更新はpoll後に開いているtabへ反映する。viewerの削除actionは紐づくcommentとpostの件数、
参照が無効になること、不可逆性を確認してから実行し、成功後はtabとsidebar itemを閉じる。

Structureは別のvirtual folderへ同じPRのcurrent artifactを複数表示する。選択するとdedicated graph viewerを
同じdocument workspaceへ開き、1/2-hop / All、focus、pan / zoom / fit / drag、Relation選択、
exact source actionを提供する。Walkthrough Markdown viewer、Mermaid renderer、Phase 0 fixture rendererを
再利用してStructureの意味を擬似実装しない。poll updateではopen tabのtitle / contentを置き換え、sessionの
stable-ID位置とviewportをreconcileする。source actionとpane移動後にStructureへ戻ってもorientationを保つ。

## 11. Reset

`rvw pr reset <PR> --yes`は対象PRのlocal comments、posts、targets、Walkthrough、code reference、Structure、
`refs/rvw/pr/<n>/...`
を削除し、現在のGitHub状態を同期してcurrent head refを作り直す。削除件数を事前表示し、
CLIは`--yes`必須とする。不可逆であり、明示的な利用者authorizationなしにAgentが実行しない。

## 12. Server / security

- Node 24 LTS、Hono、React/Vite、TypeScript strict、pnpm 11
- `127.0.0.1`の空きportだけへbind
- expected Hostを検証
- write APIは`application/json`だけ
- same-origin以外のwriteを拒否、CORSを有効にしない
- GitHub attachment readも存在するFetch Metadataと`Origin`でsame-originへ限定し、画像responseへ
  `Cross-Origin-Resource-Policy: same-origin`を付ける
- browser tab leaseはtransport-onlyで永続化しない。一覧画面も同じviewer heartbeatを更新する
- 通常の自動openはactive runtimeがなければdatabase ownershipを持つbackground workerを一つだけ起動する。
  worker ready後にbrowserを開き、最初のviewer heartbeatを確認してから親CLIを終了する
- 同じdatabaseのactive runtimeがあればworker、Runtime、SQLite、HTTP serverを追加せず、内部socket操作で
  requested PRを開いて同じoriginのURLをbrowserへ渡す。この操作はPR解決中に期限なしのoperation reservationで
  runtimeを維持し、解決後に30秒のbrowser startup reservationへ切り替える。最初のbrowser heartbeatが通常の
  tab leaseへ引き継ぐ。reservation中は最後のtab終了後の停止を延期し、解決後も未接続ならtimeout後に解放する
- browser起動失敗、初回worker error、30秒以内に最初のviewer heartbeatがない場合は初回workerを停止して
  明示的なerrorを返す。再利用時のbrowser起動失敗は既存runtimeを停止しない
- background runtimeはpersistent daemonではなく、一覧を含む最後のviewer tab終了後に短い猶予を置いて
  serverとともに停止する。複数tabの一つを閉じても他が残る間は停止しない
- `--foreground`はterminal接続serverを明示的に起動し、同じdatabaseのruntimeが既にあればconflict errorを返す
- `--no-open`はbrowser自動起動だけを無効にする。active runtimeは再利用し、active runtimeがなければ従来どおり
  signal管理のserverを起動する。browser管理のactive runtimeを再利用した場合はCLI自身がviewer leaseを
  Ctrl+Cまでheartbeatし、終了時にreleaseする
- 初回の明示`--port`は尊重する。active runtimeと異なる非0 portを指定した再利用はconflict errorとし、
  二つ目のserverを起動しない
- SQLiteはWALでserver processを扱い、Agent CLIの書き込みは可能ならuser専用Unix socketを経由する

同一PRを同じruntimeの複数viewer tabで開くことは許容する。SQLite writeは`BEGIN IMMEDIATE`を使う。
Phase 1ではDBとGit refを単一transactionにできないため、失敗時の補償削除と起動・同期時の
invariant検証を行う。refとSQLiteの不整合を検出した場合は部分的に自動修復せずresetを案内する。

## 13. Error方針

ユーザー修正可能errorはcode、短いmessage、具体的suggestionsを返す。silent fallbackしない。

- gh/git未導入・未認証
- PR URL不正、未登録、closed/merged PRの新規登録
- base repository mismatch
- object fetch失敗
- local changes未commit、head未push
- dirty判定errorには対象repository pathとstatus entry一覧を含める
- invalid commit range / object / path
- invalid Walkthrough reference / Mermaid binding / HTML preview / line range
- invalid Structure identity / endpoint / focus / source anchor / line range / payload
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
- Walkthrough schema、URI、Markdown reference / HTML preview validation、行comment placement
- Structure schema、URI、neighborhood completeness、Node非衝突、entrypoint／direction-biased canonical layoutとsession reconciliation
- DB migration 001→current
- Pull Request一覧のGitHub更新日時順、stable tie-breaker、aggregate count、Closed / Merged filter適用後の
  pagination、既存行の不明な作成日時と状態、Open／状態未取得だけを対象とする明示的な一括status更新と部分失敗

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
- Agent socket経由のwrite、implicit fallback、explicit fail-closed、diagnostic、process間単一runtime owner、
  同一databaseのopen再利用、異なるdatabaseの独立runtime、stale owner/socket recovery、明示port conflict
- doctorのDB write transactionとAgent疎通
- source anchor付きWalkthroughの登録、取得、同一ID完全置換、全体／行comment保持とOutdated、確認付き削除、reset削除
- source anchor付きStructureの登録、一覧、取得、同一ID atomic完全置換、PR ownership、ref rollback、確認付き削除、reset削除
- worktree間共有

E2Eで登録済みPR一覧、Closed / Merged filterと状態未取得行、empty state、URLに保持するpagination、
2ページ目からviewerを開いた後の
Back / Forward、一覧遷移後の未送信draft警告、一覧へ戻る直前のreading position、相対日時の更新、
Open / Draft / Closed / Merged badge、一覧表示中のviewer heartbeatを確認する。既存のreview E2Eは次を維持する。

1. PRを開きlatest commitと最新Pull Request.mdを表示
2. commit subjectで一件選択へ切り替え、open tabを維持
3. click、drag、PR全体shortcutを使うinclusiveなcommit range diffとlatest表示
4. 全ファイルから未変更fileを開く
5. 行comment、URI copy、reply、post edit/delete、resolve時の折りたたみ
6. refreshでnew commitへ更新し、historical commit選択時は維持
7. headを変えないPR本文だけのrefreshで、行数が変わった最新本文を末尾まで表示
8. 既存PR本文commentのinline位置とOutdated表示を同じrefreshで更新
9. old code commentのtrackingまたはOutdated
10. WalkthroughまたはStructureを開いてもcode tabを自動で開かず、Walkthroughのinline reference／Mermaid
    nodeまたはStructureのNode／Edge source actionを人間が
    選んだ時だけanchorから最新HEADへ直接mappingする。成功時はrenameとline shiftを含む最新位置、
    変更・曖昧・削除時は途中commitを探索せずanchorへfallbackし、説明tabを保持する。fallbackはshort SHA、
    最新で変更済みの説明、利用可能な最新file actionを表示する。latest解決の変更表示はglobalなcommit
    比較範囲を維持し、head更新後は旧／新SHAと再解決actionを表示する。anchor missing時はtabを開かず一時的な
    リンク切れchip、通信や一時的な取得失敗では区別したstatusを表示
11. tabをdragまたはpane menuで左右へ移し、通常clickでreferenceを左pane、`Cmd` / `Ctrl`+clickで
    右paneへ開く。同じfileを参照している場合も左右に一つずつ保持し、参照先paneだけを指定行へ移動する
12. repository MarkdownをSource / Previewで切り替え、Previewの文字列選択からsource行commentを作成する
13. flowchart node、class diagram class、sequence participant / actor、state、ER entity、architecture serviceの
    binding済み要素から同じlatest/fallback解決でcodeを開く。通常表示とexpanded viewのpointer、Enter / Space、
    reference peekを確認する
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
19. 左右それぞれのfocused paneで`Cmd` / `Ctrl`+`F`を開き、match case、whole word、regular expression、
    一致件数、前後移動、wrap、`Escape`後のpane focus復元を確認。片方の検索状態とhighlightが他方へ混ざらない
20. full-Walkthroughの`html-preview`をsandboxで表示し、exact source画像、`rvw-ref:`、source-mapped commentを
    確認する。composerはtarget付近へ表示し、HTML内部threadは外側Markdown inlineへ重複せず、markerから
    Comments sidebarのthreadをactivateできる。Pane Findはiframe本文を検索・highlight・前後移動できる
21. 同じPRのStructureを2件以上一覧し、片方を開いてもcodeを自動表示せず、1/2-hop / All、focus、
    全relation表示、Relation選択、pan / zoom / fit / drag / layout resetを操作できる
22. StructureのNode / Edge anchorを通常clickで左、modifier-clickで右へexact sourceとして開き、global
    commit選択を変えず、Structureへ戻った時とsame-subject poll update後にstable-ID位置とviewportを維持する
23. focusなしとAllで全Node / Edgeが表示され、同じStructureを左右paneへ開いてもsessionとDOM IDが競合しない

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
- `structure get/publish/update/delete`のschema、shared transport、同一ID whole-value update、削除preview、passive contract
- `pr sync`のreply/head関連付けと非冪等時の再取得
- 4つのSkillの初回install、同一内容の再install、いずれかに差異がある場合の更新検知と`--force`
- Skill installerが対象Skill directory外を変更しないこと
- `skill status --json`のschema

Package smoke:

- tarballへ`dist`、migrations、Skills、CHANGELOG、README、SECURITY、LICENSEだけを必要範囲で含める
- CLIはNode built-in以外のruntime依存を`dist/cli.mjs`へbundleし、package manifestにruntime
  `dependencies`を残さない
- 空のnpm cacheを使ってtemp prefixへoffline global installし、`rvw --version`と`rvw doctor`を実行
- temp Skill rootへCodex / Claude Code向けの同じ4つのSkillをinstallし、`skill status --json`で一致を確認
- static assets、migrations、`rvw` / `rvw-walkthrough` / `rvw-structure` / `rvw-watch-comments` Skill assetがtarballに存在することを確認

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
検証・publish・current値更新・確認付き削除用の`rvw-walkthrough`、Structureのbehavior／entrypoint選択・検証・publish・
current値更新・確認付き削除用の`rvw-structure`、新規post監視用の`rvw-watch-comments`を配置する。四つの
Skillの名前と内容はCodex / Claude Codeで共通とし、
platform adapterが変えるのは既定のSkill rootだけとする。Agent名はSkillへhardcodeせず、CLIの任意
`authorLabel`として実行中Agentが正確に判断できる場合だけ渡す。

`rvw-walkthrough`は一つのcurrent `sourceOid`、exact code reference、Mermaid binding、passiveなpublishと
同一ID更新、削除の明示authorizationを規定する。説明の見出し、順序、分割、粒度、diagram選択はsessionの
requestとrepository contextへ委ね、固定の文書templateを要求しない。Walkthroughはreviewerが変更または
明示された実装対象のmental modelを作るための最初の読解経路とし、作成指示を優先して、未指定部分だけを
既定guideで補う。diffやfileの一覧、網羅的なAI review、完全性の保証にはしない。更新時は既存artifactを読んで完全置換し、
改訂版を別artifactとして暗黙にpublishしない。削除は対象と件数への明示authorizationなしに実行しない。

`rvw-structure`は「Structureはbehavior space、Walkthroughはpath」をrouting boundaryとする。user / caller / PR本文の
明示behavior、entrypoint、scopeを最優先し、実際のcommit済みrepositoryを調査して不足だけを補う。code-centeredな同じ
abstraction levelのNode、verb-based Edge label、stable claim ID、一つのexact `sourceOid`を要求する。
concept-only Nodeは明示authorityまたは必要な接続に限定し、巨大graph、file inventory、AI推論edge、layout hint、
review conclusion、静的なarchitecture／責務inventoryを作らない。同じsubjectだけをsame URIへ完全置換し、別subjectは新規publishする。viewerを
開かず、削除preview後の明示authorizationなしにdeleteしない。producer品質はfixture転記ではなくAgentが
repositoryを調査して作った2〜3件のStructureでscope、granularity、concept-node使用、Edge label、anchorを
評価し、結果をdocsへ記録する。

`rvw-watch-comments`は一つの外部Agent taskをreceiverとして使い、cursorless起動で既存未解決を処理せず、
新規root/replyをPRごとのbatchへまとめる。同梱preflight、watch driver、state script、auto-ackが
prerequisite確認、cursor resume、RFC 7464 ingest、pending通知、queue、lease、retry、comment URIごとの
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
investigate-and-replyだけを許可したtaskでは同一PRのactive lease中に到着したeventも別leaseとして並列委譲し、
fix-and-pushを許可したtaskでは同一PRの後続eventを先行lease解放後まで待たせ、repository writerもwrite
reservationで直列化する。retryable failureは`nextAttemptAt`到達後に、新しいwatch eventやreconnectを待たず
auto-ackする。subagentを速やかに起動できない場合はleaseをretryable
failureへ戻し、親taskが代行しない。subagentごとに一leaseだけを割り当て、絶対pathのatomic JSON fileを
唯一の最終結果回収経路にする。subagentの最終結果はbody、
`relatedCommitOid`、完全なtyped reference配列、push状態を持ち、具体的なcode上の結論、実装、testには
navigation価値のあるexact rangeを既定で付ける。task起動時の
明示許可がある場合だけ、live authorが起動時
GitHub loginと一致し、head repository/branch/OIDとpush先も一致するPRをfix-and-pushにできる。他人または
不明なPRはinvestigate-and-replyとする。rvw自身はAgent sessionやtask stateを管理しない。

Phase 2ではnpm account、scope、2FA、LICENSE、README、CHANGELOG、SECURITY、dependency license、
macOS/Linux/Windows smokeを確認してから公開する。通常CIはregistryへ書き込まない。release workflowは
手動dispatch、`npm-production` Environment、GitHub-hosted runner、`id-token: write`を使い、OIDC
Trusted Publisherには`npm stage publish`だけを許可する。version、APP_VERSION、exact release tag、
CHANGELOG、stable=`latest` / beta=`beta`のdist-tag対応を検証し、package smokeがinstallした同一tarballを
stageする。人間が内容を確認し、2FAでapproveするまで
publicにはしない。

npmは未作成packageへTrusted Publisherを設定できずstaged publishingも受け付けないため、最初の`0.1.0`
だけはcleanなtag checkoutで検証した同一tarballを2FA付きdirect publishする。長期publish tokenは作らず、
初回公開直後にstage-only Trusted Publisherを設定して従来tokenを禁止する。詳細は`docs/releasing.md`を
source of truthとする。

## 16. Phase 1 Definition of Done

Functional:

- URLまたはcurrent branchからopen/draft PRを開き、登録済みPRはofflineでも状態badge付きで再表示できる。
- destination commit選択、PR全体diff、複数commit range、changed/all tree、全文、検索を利用できる。
- `Pull Request.md`は常に最後に成功した同期の最新内容だけを表示する。
- Agentがsource anchor付きWalkthroughをCLIで提示し、feedback後は同じIDのcurrent値を改善でき、人間が任意の
  referenceだけを最新HEAD上の対応箇所、または明示されたanchor fallbackとして最大二ペインのtabで検証できる。
  不要なWalkthroughは件数確認後に削除できる。
- AgentがboundedなPR-relevant behaviorをentrypoint付きStructureとしてCLIで提示し、人間が1/2-hop / AllとRelation選択を
  自由に探索し、Node / Edge anchorをexact sourceで開ける。同じsubjectの更新ではstable IDに基づく空間を
  session内で維持し、別subjectは別artifactにする。不要なStructureは件数確認後に削除できる。
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
- README、一次仕様、decisions、CLI protocol、4つのbundled Skillが同じ利用者モデルを説明する。

Manual acceptance:

1. 実PRを開き、最新`Pull Request.md`から変更の意図を確認する。
2. 変更fileを入口に全文、all files、検索を使い、関連するdiff外fileまで辿って結果の実装を理解する。
3. Agentが実装説明をWalkthroughとしてpublishし、viewerの表示位置が勝手に変わらないことを確認する。
4. 人間が説明内の一部referenceとdiagram nodeだけを選び、説明tabを残したままexact codeを読む。
5. AgentがPR-relevant behaviorをentrypoint付きStructureとしてpublishし、人間がfocusと近傍を変えながらNode / Edgeの
   exact sourceを左右ペインへ開く。tab往復とcurrent値更新でorientationが保たれることを確認する。
6. diff外fileを含む具体的なsourceへline commentを作り、そのURIをAgentへ渡す。
7. Agentが対象sourceと周辺contextを調査し、authorizedな修正、test、commit、push、必要なPR本文更新を行う。
8. Agentが`rvw pr sync --stdin --json`でreplyを追加する。
9. Viewerでnew commitのrepository、任意のcommit range、最新PR本文、comment trackingを読み直してresolveする。

ここまで手動DB編集、内部ID入力、独自の版取り込み操作なしで完了する。

## 17. 変更してはいけない判断

- review version、manual capture、version summaryを再導入しない
- Walkthrough revision履歴、version selector、改訂版の自動複製を追加しない
- Structure revision履歴、generic Artifact layer、comment/group、durable座標、AI推論graphを追加しない
- PR本文履歴やPR revision selectorを追加しない
- PR本文をcommitへ擬似的にbindingしない
- Ask/AI chat/Agent spawnを追加しない
- Agentにbrowser tabやscroll位置を操作させない
- unresolved/resolved以外のcomment stateを追加しない
- Skill-less fallback、GitHub comment syncを追加しない
- changed filesやdiffだけをrepository readingの境界にしない
- ORM、monorepo、Electron/Tauri、Dockerを導入しない
- live browser stateをAgent protocolへ入れない

変更が本当に必要な場合は、問題、代替案、選択、trade-offを`docs/decisions.md`へ記録する。
