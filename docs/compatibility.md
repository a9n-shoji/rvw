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
capabilityを確認してください。明示的なIssue cache修復は`issue.cacheRepair`を要求します。

最初のpublic compatibility contractはprotocol version 1です。公開前に使用した内部version番号は
互換性保証の対象外であり、現在のschemaを過去のversion 1へ戻すことを意味しません。public release後は
version番号を再利用せず、breaking changeのたびに単調増加させます。

現在のmachine contractはprotocol version 4です。Pull Request / Repository Reviewの明示context、Issue
documents、review kindで判別できるcomment eventを導入したため、version 3 consumerは新しいeventを
安全に処理できません。同梱する3つのSkillはversion 4と必要capabilityをpreflightで確認します。
version 4のcomment / watch contextはstableな`pullRequestId`または`repositoryReviewId`をrouting identity、
PR URLまたはcanonical repositoryを表示値として別々に返します。Walkthrough publish/update成功responseは、direct executionとAgent socketの双方で
`walkthrough`と常設の`issuesAdded`配列を返し、後者は同じtransactionで実際に追加したmembershipだけを
含みます。requestのaddition-only field名は`issuesToAdd`です。Repository Review watcher worker resultは`context.kind = "repository"`、`repositoryReviewId`、repositoryを返し、fake Pull Request
URLへfallbackしません。Repository Review completion helperはlease、context、read-only outcome fieldsをすべて
必須として、欠落時はreply投稿前に拒否します。
既存v3 watcher stateは、最初の対応するv4 event ingest transactionでPR URL keyを実際のstable PR IDへ
re-keyします。pending duplicateは統合し、同時にactiveな旧／新leaseはquarantineして二重claimしません。
再起動時に次eventより先にlegacy pending leaseをclaimした場合は、`comment get`でstable IDを解決し、
acknowledgement投稿と`batch-acknowledged`出力より前にそのactive leaseをtransactionally re-keyします。
ただしclaimした全commentが既に削除済みなら、stable IDへre-keyする根拠もworkerへ渡す対象もないため、
acknowledgementを投稿せず旧keyのままbatchをcompleteし、`batch-discarded`を出して監視を継続します。

2026-08-23時点でpackage 0.3.0、protocol v4、migration 011はpublic release／npm packageとして未公開です。
そのため011のcanonical owner/repository collationとv4のRepository Review operation契約はrelease前の最終形へ直接更新し、
旧011とのpartial-schema/runtime fallbackは提供しません。0.3.0以降は適用済みmigrationを書き換えずforward
migrationと新しいprotocol versionで互換性を扱います。
0.3.0の変更は実際の公開まで`CHANGELOG.md`の`Unreleased`に置き、公開時にだけ実際の日付を持つsectionへ
移します。`verify-release`はrelease tagに対してdated sectionを要求します。公開判定はGit tag、GitHub release、
npm registryを合わせて行います。

Repository Reviewのlocal source bindingはGit common directory単位です。同じcommon directoryのworktreeは
互換ですが、local GitHub remoteが解決できる場合は保存済みcanonical identityも一致する必要があります。
独立clone、remote変更、repository rename／organization transferへの自動移動は互換性契約に含めません。
元のbindingで既存reviewを明示resetしてから作り直すことが移動境界です。retained Repository Review refは
`refs/rvw/repository/<repositoryReviewId>/...`が所有し、reset後の新しいIDは旧orphan refを認識しません。
worktreeとGit common directoryはfilesystem realpathへ正規化し、verified cached openは公開済み0.2.x DBの
非canonical path表記もrealpathへ更新します。選択remote名／URLはorigin-firstの同じresolverを表示とfetchで
使います。retained ref分類はopen／viewer／doctorの診断surfaceであり、doctorは40-64桁OIDを扱いrefを自動修復・削除しません。

remoteを解決できなくても、保存済みGit common directoryとreview-owned source refが一致すればcached read、
comments、Issue removal、resetは利用できます。syncとIssue addはremote identityを安全に確認できるまで拒否します。
reset、Issue removal、comments、syncは未登録reviewを暗黙作成しません。
同じcommon directoryの別worktreeからremoteなしでcached openした場合、owned refとGit objectの一致を条件に
保存locationを現在worktreeへ更新します。previewだけでは更新しません。HTTPのstable Repository Review IDは
reset/recreate後のreplacementへフォールスルーしません。初回retained-ref作成失敗は、明示的な
`initialization_state`とref 0件を確認するresetでcleanupできます。`pending`はref作成前に保存され、
ref作成後の未ready stateは次回cached openで
完了されます。同時初回openのloserは既存rowを変更せず、winnerのowned sourceを確認します。aggregate発見前に
取得したsnapshotは破棄し、generation取得後にGitHub metadataを再取得してからexpected ID付きで更新します。
reset後に遅れて作成された初期refはexact ref単位でbest-effort cleanupされます。既存Issue refreshは削除済みmembershipを
復活させず、削除済みreviewのerrorを共有cacheへ書かず、削除後のfetch失敗もwarningではなくskipします。
ready化後の遅延completionはsource進行後も冪等で、aggregateが存続する限りhistorical refを
補償削除しません。ref初回作成はGit compare-and-swapで単一creatorだけが所有を返します。
PR／Repository ReviewのComment、reply、Walkthrough writeも、同じrefへ別processが既に依存し得るためSQLite失敗時に
補償削除しません。未参照refはdoctorで診断し、暗黙GCは行いません。
pending初期化だけを最大5秒待ち、failed stateは直ちにfail closedします。既存source同期はmigration 011の内部generationで
新しい開始順を守り、古いOIDやerrorを公開しません。metadata取得後にdefault branchが進んだ場合は一度だけsnapshotを
取り直します。共有Issue cacheはGitHub `updatedAt`をversionとして古い成功を無視し、取得snapshotの変わった古い失敗も
無視します。失敗CASはmillisecond時刻ではなくaccepted successごとに増える内部generationを使い、
sync errorは共有rowではなくreview membershipへ保存します。最後のmembership削除はorphan cacheをGCし、
所有中のequal-version conflictは二回の一致snapshotを要求する明示force refreshでrepairできます。
同じversionで内容が異なるresponseは`GITHUB_ISSUE_ERROR`です。reply idempotency keyはPR／Repository Review共通の
database-wide keyspaceです。Repository Reviewのrequest hashはReview種別を含み、PRは公開済み0.2.xの永続ledgerと
exact retry互換のある従来hash形式を維持します。
GitHub Issue response identity不一致はprotocol共通の
`GITHUB_ISSUE_ERROR`であり、rename／transferへ自動追従しません。
PR／Repository Review reset、Issue removal、Walkthrough deletionの実行はpreviewのchange sequenceへ結び付いた
confirmation tokenを必須とします。stale tokenは`DESTRUCTIVE_PREVIEW_STALE` (409)とcurrent previewを返し、
最終SQLite CASで検出した競合でも同じshapeを維持し、新しいartifactを削除しません。PR resetは既存
historical refsを削除せずpreserved情報として返します。Repository Review DB deletion後のref cleanup失敗はtyped partial successで、削除済み
aggregateへ戻らず隔離prefixを報告します。
Issue-target Commentは作成transactionでもReview membershipを再確認し、並行削除後は共有cacheが別Reviewに
残っていても`ISSUE_NOT_FOUND` (404)となります。PR resetは返却用commit一覧をSQLite削除前に読み、Git read失敗時は
artifactを削除しません。最終CASでstaleになったRepository Review resetのcurrent previewは最新のReview metadataも返します。

Issue本文cacheとmembership固有sync stateは別型／別getterです。`comment get`は所有membershipのstale状態を
返し、Walkthrough `issuesToAdd`の正常取得は既存membershipのsync errorをclearします。

次はpublic APIではありません。

- `src/`内moduleの直接import
- SQLite table、column、migration fileを直接操作すること
- OS user data directory内の内部layout
- `refs/rvw/`を利用者が直接編集すること

SQLiteとGit refはrvwが管理します。downgrade互換や、手作業で変更したDB/refの修復は保証しません。
SQLite上のreview stateにはREADMEとCLIが案内する`rvw pr reset`と`rvw repository reset`を使います。PR resetは
historical refsを削除せず、Repository Review orphan refsにもこのreleaseのrvw管理下cleanup commandはありません。
