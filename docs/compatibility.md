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

Branch Reviewのlocal source bindingはGit common directory単位です。同じcommon directoryのworktreeは
互換ですが、独立cloneへの自動移動は互換性契約に含めません。既存reviewを明示resetしてから別cloneで
作り直すことが移動境界です。

次はpublic APIではありません。

- `src/`内moduleの直接import
- SQLite table、column、migration fileを直接操作すること
- OS user data directory内の内部layout
- `refs/rvw/`を利用者が直接編集すること

SQLiteとGit refはrvwが管理します。downgrade互換や、手作業で変更したDB/refの修復は保証しません。
正式な復旧経路はREADMEとCLIが案内する`rvw pr reset`と`rvw branch reset`です。
