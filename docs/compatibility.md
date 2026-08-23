# 0.x compatibility

`rvw`は0.xの間も、外部ユーザーとAgentが依存する境界を理由なく壊さないことを目標にします。一方で、
初期設計を固定するためのstable 1.0 APIを宣言するものではありません。

互換性を意識するsurfaceは次です。

- `rvw` CLIのcommand、flag、exit status
- `rvw://comment/<uuid>`と`rvw://walkthrough/<uuid>`
- `--json` responseと`rvw protocol --json`が公開するmachine protocol version / capability
- bundled `rvw` / `rvw-walkthrough` / `rvw-watch-comments` SkillとCLI protocolの組み合わせ
- user dataを新しいversionへ引き継ぐforward migration

machine-readable contractへbreaking changeが必要な場合はprotocol versionを進め、同梱Skillと文書を同じ
releaseで更新します。0.x releaseではCLIやschemaが変わる可能性があるため、自動化側はprotocol versionと
capabilityを確認してください。

最初のpublic compatibility contractはprotocol version 1です。公開前に使用した内部version番号は
互換性保証の対象外であり、現在のschemaを過去のversion 1へ戻すことを意味しません。public release後は
version番号を再利用せず、breaking changeのたびに単調増加させます。

現在のmachine contractはprotocol version 4です。Pull Request / Branch Reviewの明示context、Issue
documents、review kindで判別できるcomment eventを導入したため、version 3 consumerは新しいeventを
安全に処理できません。同梱する3つのSkillはversion 4と必要capabilityをpreflightで確認します。
version 4のcomment / watch contextはstableな`pullRequestId`または`branchReviewId`をrouting identity、
PR URLまたはcanonical repositoryを表示値として別々に返します。Walkthrough publish/update成功responseは、direct executionとAgent socketの双方で
`walkthrough`と常設の`issuesAdded`配列を返し、後者は同じtransactionで実際に追加したmembershipだけを
含みます。Branch watcher worker resultは`context.kind = "branch"`、`branchReviewId`、repositoryを返し、fake Pull Request
URLへfallbackしません。Branch completion helperはlease、context、read-only outcome fieldsをすべて
必須として、欠落時はreply投稿前に拒否します。

2026-08-23時点でpackage 0.3.0、protocol v4、migration 011はpublic release／npm packageとして未公開です。
そのため011のcanonical owner/repository collationとv4のBranch operation契約はrelease前の最終形へ直接更新し、
旧011とのpartial-schema/runtime fallbackは提供しません。0.3.0以降は適用済みmigrationを書き換えずforward
migrationと新しいprotocol versionで互換性を扱います。

Branch Reviewのlocal source bindingはGit common directory単位です。同じcommon directoryのworktreeは
互換ですが、local GitHub remoteが解決できる場合は保存済みcanonical identityも一致する必要があります。
独立clone、remote変更、repository rename／organization transferへの自動移動は互換性契約に含めません。
元のbindingで既存reviewを明示resetしてから作り直すことが移動境界です。retained Branch refは
`refs/rvw/branch/<branchReviewId>/...`が所有し、reset後の新しいIDは旧orphan refを認識しません。

remoteを解決できなくても、保存済みGit common directoryとreview-owned source refが一致すればcached read、
comments、Issue removal、resetは利用できます。syncとIssue addはremote identityを安全に確認できるまで拒否します。
reset、Issue removal、comments、syncは未登録reviewを暗黙作成しません。
同じcommon directoryの別worktreeからremoteなしでcached openした場合、owned refとGit objectの一致を条件に
保存locationを現在worktreeへ更新します。previewだけでは更新しません。HTTPのstable Branch Review IDは
reset/recreate後のreplacementへフォールスルーしません。初回retained-ref作成失敗は、専用markerとref 0件を
確認する明示resetでcleanupできます。markerはref作成前に保存され、ref作成後の未clear markerは次回cached openで
完了されます。同時初回openのloserは既存rowを変更せず、winnerのowned sourceを確認します。aggregate発見前に
取得したsnapshotは破棄し、generation取得後にGitHub metadataを再取得してからexpected ID付きで更新します。
reset後に遅れて作成された初期refはexact ref単位でbest-effort cleanupされます。既存Issue refreshは削除済みmembershipを
復活させず、削除済みreviewのerrorを共有cacheへ書かず、削除後のfetch失敗もwarningではなくskipします。
initialization marker clear後の遅延completionはsource進行後も冪等で、aggregateが存続する限りhistorical refを
補償削除しません。ref初回作成はGit compare-and-swapで単一creatorだけが所有を返します。
pending初期化だけを最大5秒待ち、failed markerは直ちにfail closedします。既存source同期はmigration 011の内部generationで
新しい開始順を守り、古いOIDやerrorを公開しません。metadata取得後にdefault branchが進んだ場合は一度だけsnapshotを
取り直します。共有Issue cacheはGitHub `updatedAt`をversionとして古い成功を無視し、取得snapshotの変わった古い失敗も
無視します。失敗CASはmillisecond時刻ではなくaccepted successごとに増える内部generationを使います。
同じversionで内容が異なるresponseは`GITHUB_ISSUE_ERROR`です。reply idempotency keyはPR／Branch共通の
database-wide keyspaceです。Branchのrequest hashはReview種別を含み、PRは公開済み0.2.xの永続ledgerと
exact retry互換のある従来hash形式を維持します。
GitHub Issue response identity不一致はprotocol共通の
`GITHUB_ISSUE_ERROR`であり、rename／transferへ自動追従しません。

次はpublic APIではありません。

- `src/`内moduleの直接import
- SQLite table、column、migration fileを直接操作すること
- OS user data directory内の内部layout
- `refs/rvw/`を利用者が直接編集すること

SQLiteとGit refはrvwが管理します。downgrade互換や、手作業で変更したDB/refの修復は保証しません。
正式な復旧経路はREADMEとCLIが案内する`rvw pr reset`と`rvw branch reset`です。
