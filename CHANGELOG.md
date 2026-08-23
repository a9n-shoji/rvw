# Changelog

公開releaseごとの利用者向け変更を記録します。package versionとAgent向けprotocol versionは独立して
管理し、machine contractのbreaking changeはprotocol versionにも明記します。

## [Unreleased]

## [0.3.0] - 2026-08-22

### Added

- GitHub repositoryごとに一件だけ保持し、default branchのexact commitを読むBranch Review
- Pull Request ReviewとBranch Reviewで、GitHub Issue本文を通常文書として読む・コメントするsurface
- Branch Reviewのcomment eventをcontext別にbatchし、read-only調査と冪等な最終replyを行うwatcher mode
- 件数previewと明示確認を伴うPR / Branch Issue membership削除、およびBranch Review reset
- Pull Request / Branch ReviewのIssue本文に貼り付けたmodern GitHub user attachment画像を、既存の
  review-scoped localhost proxyと同じ検証・認証・画像判定で表示
- repository demoのPR本文とIssue本文へ、安全な添付と停止対象の外部画像を並べたMarkdown tableを追加

### Changed

- comment、Walkthrough、watch eventをPull Request / Branch Reviewの明示contextで扱うprotocol v4
- watch eventのrouting identityを表示用URL／repository名から安定したreview IDへ変更
- Issue cacheをGitHub identityで共有しつつ、membershipとreview artifactを各reviewへ分離
- Branch ReviewをPR Reviewと同じExplorer / Search / Comments、document tab、最大二pane、theme、
  comment操作へ統一し、PR固有controlだけを省略
- IssueをPR本文・Walkthroughと同列のreview文書nodeへ統合し、追加formを必要時だけ開くUIと、共通Markdown
  viewerからのIssue全体／本文選択コメントへ変更
- Walkthrough publish/update responseを、transportに依存しない`walkthrough` + `issuesAdded` envelopeへ変更
- watcher worker resultをPull Request URL前提からreview contextのdiscriminated unionへ変更
- `rvw-watch-comments`のinvestigate-and-reply専用taskで、同じPR／repositoryの後続batchもworker capacity内で
  並列に調査・返信。保証できる場合は`max-in-flight=8`を目標とし、fix-and-pushを許可したtaskだけ従来の
  writer排他を維持
- Branch watcherのread-only境界を保ったまま、current／retained sourceのtyped code referenceを最終replyへ
  付けられるよう変更
- Issue同期を認証確認の共有と最大8件のbounded concurrencyへ変更
- viewerの変更pollをdatabase全体からreview kind／ID単位へ絞り、別reviewの更新による再取得を削減
- Branch retained refをrepository名ではなくBranch Review ID単位で所有し、reset/recreate後のevidenceを分離
- Branch lifecycleのcreate、existing-only、sync、destructive binding policyをapplication層へ集約
- migration 011のcanonical repository一意性をcase-insensitiveにし、protocol v4の全transportを最新service前提へ統一

### Fixed

- Issue本文が更新された後も全体コメントはcurrentのまま維持し、rangeコメントだけをoutdatedにするよう修正
- Branch Review resetでGit ref削除が適用済みなら、終了statusだけを根拠に不整合errorを返さないよう修正
- `investigate-and-reply`で開始したwatch taskがPull Requestのwrite reservationを取得できる抜け道を修正
- Branch Issue本文の同期でviewerをremountせず、入力中のrange comment draft、selection、focusを保持するよう修正
- Branch syncが共通document queryを正しく更新し、Issue本文とOutdated placementを最新化するよう修正
- 同じGitHub repositoryの独立cloneから既存Branch Reviewを開いても、保存済みGit common directoryを
  暗黙に再bindしないよう修正
- Branch watcherの最終reply post IDをdurableにself-suppressし、event ingest順序や再起動による自己loopを修正
- Walkthroughの`issuesAdded`をtransaction外のsnapshot差分ではなく、実際に追加したmembershipから返すよう修正
- Branch completion helperがworker contextとread-only outcome fieldsの省略を投稿前に拒否するよう修正
- Issue membership削除後に対象Issueの未送信draftだけが復活し得る問題を修正
- Branch Reviewがclone内に存在するだけの未同期local commitをdocumentやcomment evidenceとして受理する問題を修正
- PR本文のinline/fenced codeやraw HTML内に書かれた`#123`をIssue membershipとして誤検出する問題を修正
- 初期background refreshの完了が、待機中に人間が選択したhistorical commit rangeを上書きするraceを修正
- reset／Issue removal preview、comments、syncが未登録Branch Reviewを暗黙作成する問題を修正
- cache hitを含む全path-based Branch操作でlocal remote identityを検証し、remote変更後の取り違えをmutation前に拒否
- resetのref削除失敗で残った旧review refを、新reviewのdocument、Comment、Walkthrough evidenceとして受理しないよう修正
- concurrent first openのidentity lookupとID決定を一つのimmediate transactionへ移し、raw unique constraint raceを修正
- 外部Branch Walkthrough更新時にsummaryだけでなく左右paneのdetail本文、reference、diagram bindingも再取得し、draft、focus、scrollを保持
- HTTPのBranch Review ID-bound操作がreset/recreate後の同一pathにあるreplacement reviewへフォールスルーするraceを修正
- remoteなしでも同じGit common directoryの別worktreeからowned sourceを読み、cached open時だけ保存pathを安全に更新
- 初回Branch retained ref作成失敗を、専用markerを検証する明示resetで手動DB編集なしに復旧可能に変更
- GitHub Issue responseと差し替え可能なGitHub portのcanonical identityを二層検証し、cache／membership書き込み前に拒否
- 新規Comment threadが静止pointer直下へ挿入されただけでMarkdown行をactive highlightする問題を修正
- background Issue refreshが同期中に明示削除されたPR／Branch membershipを再作成するraceを修正
- 削除済みreview由来のIssue sync errorがreplacementや別ownerの共有cache／sequenceを更新するraceを修正
- Branch初期化markerをretained ref作成前に保存し、process停止位置に応じて明示resetまたは次回openで復旧
- Branch viewerがIssue identity mismatchなどの部分失敗を同期成功だけでなくwarningとして表示
- 異なるsource OIDを返す同時初回openで、loserがretained ref作成前に既存aggregateのsourceを公開するraceを修正
- reset完了後に遅延作成された初期retained refをexact ref単位でbest-effort cleanup
- Issue削除後に遅れて失敗したPR／Branch refreshをwarningではなく`membership-removed`としてskip

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
