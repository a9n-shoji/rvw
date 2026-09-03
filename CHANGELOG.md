# Changelog

公開releaseごとの利用者向け変更を記録します。package versionとAgent向けprotocol versionは独立して
管理し、machine contractのbreaking changeはprotocol versionにも明記します。

## [Unreleased]

## [0.5.0] - 2026-09-03

### Added

- Structure contentを保存せずcanonical projection、layout diagnostics、authoring warningsを確認できる
  `rvw structure preview --stdin --json`と`structure.preview` protocol capability
- Structure publish / update成功時に、保存済みgraphから導出したlayout authoring warningを返すfeedback loop

### Changed

- Structureのinitial projectionをpair-level topologyとSCC layeringを共有する実装へ整理し、terminal / hub originの
  predecessorをnegative rankへ展開。入力順やpresentation contentに依存しないdeterministicなrefinement、diagnostics、
  initial viewportを導入
- Structure Skillにpublish / update前のcanonical preview、factual entrypointとしてのorigin選択、短いEdge predicate、
  overlapping / nested Node anchorの再検討手順を追加
- ViewerのEdge labelをgeometryと一致する最大2行へ制限し、SVG / PNG exportでは全文を省略せずwrapして保持

### Fixed

- terminal originへ入る多数のpredecessorがoriginと同じ左端columnへ潰れ、non-forward relationと縦積みが増える問題
- Viewer向けEdge labelのellipsisがSVG / PNG exportにも流用され、standalone artifactからrelation全文が失われる回帰

## [0.4.3] - 2026-09-02

### Fixed

- 初回revision snapshotの取得中やPull Request取得中に、commitが存在するPRでも一時的に
  `PR commitがありません。`と表示される回帰
- 初回revision snapshotの取得失敗をcommitなしとして扱わず、APIの実エラーを表示するよう修正
- Pull Requestのcommit取得完了後、latest headの選択が初期化されるまでempty stateへ遷移する問題

## [0.4.2] - 2026-09-02

### Changed

- comment placementをpane／sidebar単位のbatchへ集約し、100 commentsでもrequest数とGit subprocess数を
  destination数に応じた一定量へ削減
- Pull Request本文、comment、Walkthrough、Structureのcache更新をdomainごとに分離し、無関係な更新や
  window focusでdocument、search、placement、Git commit列挙を再実行しないよう改善
- Structureのfile逆引きをrequestごとのindexへ集約し、同じsource／targetのGit処理を共有

### Fixed

- Pull Request本文更新、comment mutation、poll、repository location変更が競合した場合に、古い本文、
  comment、annotation、Git object availabilityがcacheへ残る問題
- Comments欄を閉じた際のPR全体comment draft消失、mutation直後の並び順の乱れ、500 comments超の
  placement失敗、部分的なplacement失敗から再試行できない問題

## [0.4.1] - 2026-09-01

### Added

- repository fileから、そのfileをNode sourceとして参照するStructureをrename-awareに逆引きし、対応Nodeへ
  閲覧状態を維持したまま移動できる機能
- Structure全体を現在のNode配置のままSVGまたは2倍基準のPNGへエクスポートする機能。focus、近傍、
  viewportにかかわらず全Node、全Relation、全Edge labelを含み、画面の閲覧状態を変更しない

## [0.4.0] - 2026-09-01

### Added

- 一つの具体的なbehavior / processing flowをsource-anchored origin、stable Node / Edge ID、exact source
  anchorで提示し、1/2-hop / All、focus、pan / zoom / dragから探索できるproduction `Structure` document
- Structureのpublish / get / whole-value update / confirmation付きdeleteを行うCLI、Agent socket capability、
  SQLite migration、HTTP API、Codex / Claude Code共通の`rvw-structure` Skill
- 変更表示の原文と行番号を保ちながら、追加・削除fileを除く空白だけの変更を`…`メニューから非表示にする
  `Hide Whitespace`設定

### Changed

- 固定サイズのStructure Node内をscroll可能にし、表記ごとの余白、canvasのpan / zoom感度、source anchorの
  fallback、stale判定、明示的な再解決を改善
- light / dark themeのdiff canvas、文字、追加・削除行、gutter、inline emphasisの配色をGitHubへ合わせる
- Hide Whitespace切替時に現在のsource lineをviewportへ保持し、空白差分がすべて隠れた場合は解除方法を表示

## [0.4.0-beta.0] - 2026-08-31

### Added

- 一つの具体的なbehavior / processing flowをsource-anchored origin、stable Node / Edge ID、exact source
  anchorで提示し、1/2-hop / All、focus、pan / zoom / dragから探索できるproduction `Structure` document
- Structureのpublish / get / whole-value update / confirmation付きdeleteを行うCLI、Agent socket capability、
  SQLite migration、HTTP API、Codex / Claude Code共通の`rvw-structure` Skill

## [0.3.2] - 2026-08-31

### Added

- Markdown、comment、WalkthroughのMermaid図をviewportサイズのreview workspaceへ展開し、Fit・zoom・
  scroll、resizableなcomment rail、code referenceのpeekとreview画面へのnavigationを利用できる機能
- WalkthroughのMermaid bindingをflowchartとclassDiagramに加え、sequenceDiagramのparticipant / actor、
  stateDiagram-v2のstate、erDiagramのentity、architecture-betaのserviceへ拡張

### Changed

- Walkthroughのcode referenceを保存済みの最新PR headへ遅延解決し、fileが不変ならexact range、変更時は
  sourceとdestinationで一意な未変更rangeだけを対応付け。安全に特定できない場合はimmutableなsource commitへ
  fallbackし、rename / copyも一意な直接successorだけを追跡

## [0.3.1] - 2026-08-28

### Added

- Pull Request一覧を表示しただけではGitHubへ問い合わせず、Open、Draft、状態未取得の登録済みPRだけを
  明示的なbutton操作で一括status更新する機能

### Changed

- 同じdatabaseを使う通常の`rvw open`は既存runtimeへPRを追加し、同じHTTP originを再利用。並行起動でも
  owner lockをRuntime / HTTP serverより先に確定し、一つのdatabaseにつき一つのactive processへ限定
- 一括status更新のGitHub認証を操作ごとに一度だけ行い、最大4件並列・部分失敗許容で処理。Closed / Mergedを
  継続追跡対象から除外し、保存済みPRの累積件数ではなく現在のworking setに問い合わせ量を限定
- 一覧のPR titleを省略せず複数行で全文表示し、review画面のロゴをCmd / Ctrl / 中クリックで一覧を
  別tabに開けるnative linkへ変更

### Fixed

- status更新によって現在のoffsetが無効になった場合、最後の有効な一覧pageへ戻して誤ったempty stateを防止
- runtime停止時にHTTP / SQLiteを閉じるまでdatabase owner lockを保持し、新旧runtimeが一時的に重複するraceを防止
- 終了猶予中の`rvw open`をpending viewer leaseで保護し、`--no-open`で再利用したruntimeをCtrl+Cまで維持
- runtime停止中に到着した`rvw open`がowner解放後にownershipを再取得できずtimeoutするhandoff raceを防止
- `viewer.open`のPR解決中はoperation reservationを維持し、解決後からbrowser接続待ちtimeoutを開始

## [0.3.0] - 2026-08-28

### Added

- 登録済みPull RequestをGitHub更新日時順に一覧できるworkspace入口。未解決／解決済みcomment数、
  Walkthrough数、cached Open / Draft / Closed / Merged statusをofflineでも確認でき、Closed / Mergedだけを
  既定で非表示にする
- Walkthroughの`html-preview` fenced blockを、sanitized HTML / CSS / SVG、exact repository画像、theme、
  source navigation、comment、Pane Findに対応したsandboxed interactive previewとして表示

### Changed

- code referenceやcomment rangeへ移動したとき、changes viewの折りたたまれたhunkをまとめて展開し、
  長いrangeでも対象全体を表示

## [0.2.5] - 2026-08-26

### Added

- focus中のdocument paneで`Cmd/Ctrl+F`を押すと、code、Markdown、Walkthroughの描画内容を
  case-sensitive、whole-word、regular expressionの切り替え付きで検索できるVS Code風find widget
- PR本文とrepository Markdown preview内の`mermaid` fenced blockを、themeとsource-line mappingを
  保ったstrict Mermaid surfaceで描画
- final Agent commentをnative browser notificationで通知し、human post、acknowledgement、初回load、
  idempotent retryは通知対象から除外

### Changed

- expanded Comments sidebarの上端をpointerまたはkeyboardでresize可能にし、double-clickで自動配分へreset

### Fixed

- dual-pane表示でcomment / reply draftをpaneごとに分離し、refresh時も選択中のcommit rangeを保持
- watcher postのAgent provenanceを保持し、comment notificationを投稿種別に応じて正しく判定
- compound template extensionのsyntax highlightと、Markdown preview内code referenceのrange highlightを改善

## [0.2.4] - 2026-08-24

### Changed

- `rvw-watch-comments`のinvestigate-and-reply専用taskで、同じPR／repositoryの後続batchもworker capacity内で
  並列に調査・返信。保証できる場合は`max-in-flight=8`を目標とし、fix-and-pushを許可したtaskだけ従来の
  writer排他を維持

## [0.2.3] - 2026-08-21

### Added

- PR本文へ貼り付けたmodern GitHub user attachment画像を、public/private共通のlocalhost proxyで表示
- repositoryのPNG、JPEG、GIF、WebP、AVIF、SVGをexact commit固定の全文表示とold/new Split表示で閲覧
- 画像ファイルのadded、deleted、renamed、画像・非画像間の変更表示とfile-level comment

### Fixed

- 同じtask stateで`rvw-watch-comments`のwatch driverを複数起動できないようにし、二重監視と重複処理を防止

### Security

- GitHub attachment proxyを厳密な`https://github.com/user-attachments/assets/<uuid>`だけへ限定し、
  同一origin request、GitHub CLIの既存認証、10 MiB上限、magic-byte判定、`nosniff`、SVG sandbox CSPを適用
- arbitrary external image、legacy GitHub image host、unknown binary、HTML/JSON error responseは引き続き自動取得しない

## [0.2.2] - 2026-08-21

### Changed

- `rvw`と`rvw-watch-comments` Skillが具体的なcode上の結論、実装、testを投稿するとき、navigation価値のあるtyped code referenceを既定で付けるよう改善

### Fixed

- `rvw-watch-comments`が同じthreadの後続replyを処理するとき、以前の回答を確認中へ戻さず、新しい確認中replyを最終回答へ更新するよう修正
- Markdown Previewで別commentへの返信が同期されても、入力中の未送信replyとfocusを保持するよう修正

## [0.2.1] - 2026-08-20

### Added

- Agentが作成・返信・編集・同期するcomment postへ、exact commitに固定したinline code referenceを付与できるprotocol v3
- `rvw-watch-comments`向けの一括preflight、cursor-resume watch driver、pending待機、即時auto-ack

### Changed

- Walkthroughとcomment postがcode referenceのschema、検証、表示、navigationを共有
- 小規模batchの直接調査と、絶対pathのJSON fileによるworker結果回収をSkill契約へ明記
- comment / replyの64 KiB超過errorへ実際のUTF-8 byte上限を明記
- review sidebarをExplorerとCommentsの二階層へ整理し、PR本文、Walkthrough、repository fileを一つの
  file treeとして扱うよう変更
- Explorerと全文検索の切り替え時に、各viewの展開状態、検索語、scroll位置を保持

### Fixed

- Markdown previewの再描画後もtableの横scroll位置を保持
- Markdownのinline codeとcode blockでfont sizeが不揃いになる表示を修正

## [0.2.0] - 2026-08-20

### Added

- Agentが新しい未解決threadを安全なMarkdownで記録できる`comment.create` CLI capability
- Agentが既存post本文と関連commitを置き換えられる`comment.edit` CLI capability
- browserの戻る／進むで、review scopeやworkspace layoutを変えずに辿れるreading history
- PR commentを継続監視し、重複なく返信できる`rvw-watch-comments` Skill

### Changed

- reviewerの目的とrepository固有の指示に合わせて説明を組み立てるWalkthrough authoring guide
- `rvw-watch-comments`がclaim直後に確認中replyを追加し、同じreplyを最終結果へ更新するよう改善

### Fixed

- 不正なMermaidを含むcommentを表示すると、一時的なerror SVGがcomment外へ残りviewer下部を覆う問題

## [0.1.1] - 2026-08-17

### Fixed

- 大規模repositoryでファイルを開閉した際に、非表示のQuick Open候補を二乗時間で再計算してUIが停止する問題

## [0.1.0] - 2026-08-17

### Added

- GitHub Pull Requestのcommit履歴、変更箇所、repository全体を読むローカルWeb viewer
- PR本文、file、code line、Walkthroughへのローカルcommentと未解決／解決済みthread
- Git commitへ固定したMarkdown、code reference、Mermaid bindingのWalkthrough
- Codex / Claude Codeで共通利用する`rvw`と`rvw-walkthrough` Skill installer
- `rvw://`参照を扱うversioned JSON CLI protocol
- CLI、Web assets、database migrations、bundled Skillsを含むglobal-install package

### Security

- localhost限定server、Host / Origin検証、sanitized Markdown / Mermaid rendering
- runtime依存をCLIへbundleし、install時に追加のruntime dependency treeを解決しない配布形式
