# Changelog

公開releaseごとの利用者向け変更を記録します。package versionとAgent向けprotocol versionは独立して
管理し、machine contractのbreaking changeはprotocol versionにも明記します。

## [Unreleased]

### Fixed

- 同じtask stateで`rvw-watch-comments`のwatch driverを複数起動できないようにし、二重監視と重複処理を防止

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
