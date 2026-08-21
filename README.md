# rvw

`rvw`は、AIや人間が実装したGitHub Pull Requestを、差分だけでなく変更後のsoftware全体として
人間が理解するためのローカルviewerです。PRの意図、Git commit、変更箇所、選択commit時点の
repository全体を行き来し、PR本文、変更されたコード、変更されていない関連コードへコメントできます。
Agentが実装やarchitectureの説明を提示した場合は、説明を独立したtabに残したまま、inline linkや
Mermaid図から人間が選んだcodeだけを開けます。文書は最大2ペインへ並べられるため、
説明と実装、callerとdefinition、Markdown previewとcodeを同時に読めます。

diffは変更を見つける入口であり、レビュー対象の境界ではありません。人間が結果を読み、影響を追い、
次に直すべきことを判断します。Codex / Claude Codeは、その判断を同梱された共通Skillと`rvw` CLI
protocolで受け取り、実装へ反映します。`rvw`自身はAIを起動せず、コードを編集しません。

```text
Agentが実装
    ↓
Git commit / GitHub Pull Request
    ↓
Agentが任意でcommit固定のWalkthroughを提示
    ↓
rvwで意図・説明・変更・repository全体を読む
    ↓
人間が理解し、コードへコメントする
    ↓
Skill + CLI protocol
    ↓
Agentが次の実装へ反映
```

この考え方とプロダクト境界は[Product principles](docs/product-principles.md)にまとめています。

## 必要なもの

- Node.js 24.15.0以上
- Git
- [GitHub CLI](https://cli.github.com/)（`gh auth login`と`gh auth setup-git`を完了済み）
- PRのbase repository clone、またはそのcloneから作ったGit worktree

head fork側だけのclone、GitHub Enterprise、Closed / merged PRはPhase 1の対象外です。初回登録と同期にはGitHub接続が必要ですが、登録済みPRは保持済みGit objectとSQLite cacheからofflineでも開けます。

## インストール

npm registryからglobal installします。非scopedの`rvw` packageは別のプロジェクトなので、必ずscopeを
含めます。

```bash
npm install --global @a9n-shoji/rvw
rvw doctor
```

`rvw doctor`がGit、GitHub CLI認証、repository、database migration、databaseの実書き込み、Agent
transport疎通を確認します。registryへまだ存在しない開発checkoutを試す場合は、sourceで
`pnpm install --frozen-lockfile && pnpm build && pnpm link --global`を実行します。

レビューしたいrepositoryへ移動して起動します。

```bash
cd /path/to/base-repository-clone
rvw open https://github.com/owner/repository/pull/123
```

現在branchに対応するPRならURLを省略できます。

```bash
rvw open
```

serverは`127.0.0.1`の空きportだけへbindします。通常の`rvw open`はviewerを開き、最初のtab接続を確認してから端末へ制御を返します。serverはbackgroundで動き、最後のtabを閉じると短い猶予後に停止します。リロード中や別tabが残っている間は停止しません。

serverを端末に接続したままにする場合は`rvw open --foreground`を使います。ブラウザを開かずに検証する場合は`rvw open --no-open`を使います。どちらもCtrl+Cで停止します。一度登録したPRは、完全URLまたは全登録PRで一意な番号を指定すればrepository外のdirectoryからも開けます。

## 変更を理解する

初回openでPRのcommit履歴と最新PR本文を取得します。以後は保持済み状態を先に表示し、viewer起動後または最上部の`...` menuにある`GitHubと同期`で最新状態を取得します。独自の版取り込み操作はありません。

基本の読み方は次のとおりです。

1. `Pull Request.md`で、最後に同期できたPRの意図と説明を読む。
2. 変更ファイルとcommit rangeで、どこがどの順序で変わったかを把握する。
3. 全文、全ファイル、repository検索、開いた文書のtabを使い、変更されていないcaller、設定、test、documentまで辿る。
4. PR全体、PR本文、変更file、変更されていないfile、コード行へコメントする。
5. comment参照をAgentへ渡し、修正後のcommitを同じ文脈で読み直す。

viewerはこの流れのために次を提供します。

- `Pull Request.md`、変更ファイル、全ファイル
- 開いた文書を保持するタブ、最大2つの横ペイン、横幅をdrag調整できるsidebar / pane divider
- タブのdrag & drop、ペインmenu、sidebarからの`Cmd` / `Ctrl`+clickによる右ペイン表示
- repository内Markdown全文のPreview既定とSource / Preview切り替え（差分がある変更表示は通常のdiff、見出しlinkと同じcommitの相対画像を含む）
- 全文、選択した連続commit範囲の差分
- split / stacked diff、syntax highlight、行・範囲選択
- `@pierre/vscode-icons`による全画面共通の言語／tooling file icon
- ファイル名fuzzy検索、Gitによるrealtime全文fixed-string検索（case / whole-word、file grouping、行jump）
- PR全体、PR本文、ファイル全体、行範囲、Walkthrough全体へのコメント
- コメントと返信のsafe GFM表示（repository内link／同一commit相対画像、表示専用Mermaid、
  exact commitへ固定したinline code referenceを含む）
- 未解決／解決済み、返信、Outdated追跡
- Agentへ渡す一件・一覧・複数選択した`rvw://comment/<uuid>`参照のコピー
- Agentが提示したWalkthrough、exact code reference、選択可能なMermaid node
- Walkthrough commentをAgentが読むときの、元の説明本文とcode referenceの同時取得
- 同じ参照を保ったWalkthroughの改善と、確認付きの不要Walkthrough削除

各commitはcommit message、short SHA、commit日時で選択できます。一件はclick、連続範囲は一覧をdragするだけで両端を含めて選べ、`PR全体`と`最新だけ`のshortcutも利用できます。範囲のlatest側がheadならtop barに`最新`を表示します。`Pull Request.md`は選択commitにかかわらず常に最新です。

全文表示と全ファイルtreeが通常のrepository reading surfaceです。変更表示は同じcommit範囲へ
変更箇所を重ねるlensとして働きます。diff外のfileを開いても比較条件は変わらず、そのcommitの
全文を表示して`差分なし · 全文表示`と明示します。

## Agentの説明を人間の順序で検証する

外部Agentは`rvw-walkthrough` SkillとCLIを使い、実装説明を一つのcommitへ固定してrvwへ提示できます。

```bash
rvw walkthrough publish --stdin --json
```

説明はMarkdown、`rvw-ref:<id>` link、typedな`path + 任意のline range`、任意のMermaid node bindingから
構成されます。参照は意味のある複数行range、単行、またはfile全体を指せます。rvwは登録時にcommit、
path、指定された行範囲を検証します。publishしてもbrowserは開かれず、
active tabやscroll位置も変わりません。人間がviewerのWalkthroughを開き、必要なreferenceを選んだ
時だけ、exact sourceがdocument tabへ開き、行指定があれば範囲全体が強調されます。`Cmd` / `Ctrl`を押しながら選べば
操作元と反対のペインへ開きます。説明tabは残るため、
複数のclaimと実装を任意の順序・任意のタイミングで往復できます。

Walkthrough本文のinline referenceとMermaid node linkは維持しますが、同じ参照を横や下へ列挙する
`Code references` indexとsidebar上の参照件数は表示しません。そのため、本文linkと、本文中に実在する
flowchart/classDiagram nodeへのMermaid bindingのどちらからも使われないreferenceはpublish/update時に
拒否します。存在しないnode名だけをbindingへ宣言しても使用済みにはなりません。

Mermaidの描画はflowchartだけに限定せず、class、sequence、state、ERなどbundled Mermaidが対応する
記法を受け付けます。code referenceとの要素bindingはflowchartとclass diagramをE2Eで保証し、
SVG上の要素構造が異なる他の記法は描画とinteractionを分けて扱います。

これはin-app AI chatではありません。説明と図はAgentのclaimで、commit済みcodeが検証対象の正本です。
Walkthroughにはローカルな版履歴を持たせません。説明全体へのfeedbackはstableなWalkthrough IDへ残るため、
Agentは現在内容を読み、同じ`rvw://walkthrough/<uuid>`を更新して分かりやすくできます。更新後もコメントは
同じ説明へ残り、viewerはpollで本文、参照、titleを再取得します。不要なWalkthroughはviewerの削除action、
または削除件数を確認したCLIで、紐づくコメントと返信を含めて削除できます。

## Codex / Claude Code Skills

アプリ本体からローカルSkillをインストールします。一度のinstallで、コメント処理用の`rvw`、
Walkthroughのpublish・改善・削除用の`rvw-walkthrough`、新規コメント監視用の
`rvw-watch-comments`が入ります。Skill名と内容はCodex / Claude Codeで共通で、
platform指定は配置先だけを選びます。

```bash
rvw skill install codex
rvw skill install claude
rvw skill status
```

既定の配置先は次です。

- Codex: `~/.agents/skills/rvw`、`~/.agents/skills/rvw-walkthrough`、`~/.agents/skills/rvw-watch-comments`
- Claude Code: `~/.claude/skills/rvw`、`~/.claude/skills/rvw-walkthrough`、`~/.claude/skills/rvw-watch-comments`

rvwがインストールしたSkillには同梱版digestを記録します。`skill status --json`と`doctor --json`は、
管理済みの旧版なら`updateAvailable: true`、ローカル編集なら`locallyModified: true`、記録のない差異なら
`state: "unmanaged-difference"`として区別します。自動では上書きしないため、内容を確認したうえで
`--force`を指定してください。package smokeやカスタム配置にはplatformを明示して
`rvw skill status codex --target <SKILLS_ROOT>`のように指定します。
以前の開発版が配置した`rvw-codex` / `rvw-claude` directoryは、local変更を消さないため自動削除しません。
内容を確認してから手動で取り除いてください。

コメント対応では、Agentへviewerからコピーしたコメント参照を渡すか、対象PRの未解決コメント全体を
確認するよう依頼します。

```text
rvw Skillを使って、次のコメントを確認してください。

rvw://comment/00000000-0000-4000-8000-000000000000
```

```text
rvw Skillを使って、https://github.com/owner/repository/pull/123 の未解決コメントを確認してください。
```

Agentにreview結果をRVWへ残してもらう場合は、対象PRとコメント作成を明示します。Agentはcommit済みの
exact sourceを確認し、通常の未解決threadを一件ずつ作成します。指摘や回答の理解に別の実装箇所が
必要なら、投稿本文の`rvw-ref:<id>` linkと同じ投稿に保存したtyped referenceから、その時点のcommitを
globalなcommit選択を変えずに開けます。

```text
rvw Skillを使って、https://github.com/owner/repository/pull/123 をreviewし、見つけた指摘をRVWのコメントとして作成してください。
```

Walkthroughを作る場合は、説明したい対象と必要な作成指示をセッションへ伝えて`rvw-walkthrough` Skillを使います。
Skillは明示された指示を優先し、未指定の作成判断だけを既定guideで補って、reviewerが変更または実装対象の
mental modelを作るための最初の読解経路を構成します。文書の見出しや説明順序は固定せず、commit固定の
reference付きartifactとして検証してpublishします。Walkthrough全体へのコメントから説明を改善する場合は、
現在内容を取得して同じURIを更新し、重複した「改訂版」を追加しません。

新規root commentとreplyを継続監視する場合は`rvw-watch-comments` Skillを起動します。全登録PRを
同梱driverから約1秒間隔で監視し、起動前の既存未解決commentは処理しません。自分のPRのfix-and-pushを起動taskへ
明示許可した場合だけ、live PR authorと起動時のGitHub loginが一致するPRで修正・test・commit・pushを
行えます。fork PRではlive head repository、branch、OIDとpush先も一致させます。他人またはauthor不明の
PRは常にcode/GitHub read-onlyで調査します。同梱driverがcursor resumeとRFC 7464 ingestを行い、
batchをclaimすると各threadへ`🔎 確認中です…`をAgent往復なしに即時返信し、
完了時は同じreplyを最終結果へ編集します。Skill同梱のtask-state toolがrepository外のSQLiteへcursor、
queue、retry、batch内のthread単位status post、自己返信抑制をtransactionalに保存します。同じthreadへ
後から返信が追加された場合は新しいstatus postを返信するため、以前の回答は書き換えません。
調査結果、実装内容、test結果が具体的なcodeに基づく場合、Skillは最終replyからexact commitの有用な
line rangeへ`rvw-ref:` linkを付け、reviewerが根拠へ直接移動できるようにします。

三つのSkillはSQLiteを直接読まず、`rvw protocol --json`、`rvw comment ... --json`、
`rvw walkthrough get/update/publish/delete ... --json`、`rvw pr sync --stdin --json`だけを利用します。
ローカルDBやrepositoryへアクセスできないCloud Agentは対象外です。

## 復旧

まず`rvw doctor --json`でGit、GitHub CLI認証、現在のrepository、DB pathを確認してください。初回登録や
同期だけが失敗する場合は`gh auth status`とnetworkを確認します。登録済みPRはofflineでも開けます。

force-push前に観測したhead commitはimmutable refで保持するため、旧コメントの参照元として読めます。Git refとSQLiteの不整合は部分修復せず、削除件数を確認後、正式な復旧手段としてresetします。

```bash
rvw pr reset https://github.com/owner/repository/pull/123 --json
rvw pr reset https://github.com/owner/repository/pull/123 --yes --json
```

resetは対象PRのコメント、返信、コメント対象、コメント投稿とWalkthroughのcode reference、
`refs/rvw/pr/<number>/...`を削除し、現在のGitHub状態からcacheとhead refを再構築します。
バックアップや旧コメント移行は行わず、元に戻せません。

## CLI protocol

機械向けコマンドはstdoutへJSONだけを出します。長時間の`comment watch`だけはRFC 7464 JSON text
sequenceを出します。

```bash
rvw protocol --json
rvw agent ping --json
rvw agent status --json
rvw pr refresh <PR_REF> --json
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
rvw walkthrough get <WALKTHROUGH_URI> --json
rvw walkthrough publish --stdin --json
rvw walkthrough update <WALKTHROUGH_URI> --stdin --json
rvw walkthrough delete <WALKTHROUGH_URI> --json
rvw walkthrough delete <WALKTHROUGH_URI> --yes --json
rvw pr sync --stdin --json [--repository <PATH>] [--allow-untracked]
rvw pr attach <PR_REF> --repository <PATH> --json
```

`--stdin` commandはEOFまでJSONを読みます。改行だけでは終了しないため、processから呼ぶ場合は送信後に
stdinをcloseし、shellではpipe、quoted heredoc、input redirectionのいずれかを使います。起動済みの
対話commandへJSONと改行だけを送るとEOF待ちになります。

`comment create`は登録済みPR、通常のcomment target、本文、任意のAgent名、投稿単位code referenceをstdin JSONで受け取り、
未解決のroot threadを一件作成します。repository targetはexact commit、path、任意のinclusive line rangeを
指定し、viewerと同じ文書・行検証を通ります。作成してもbrowserを開かず、tabやcommit選択を変更しません。
同梱Skillは具体的なcode上のclaimにnavigation価値のある根拠がある場合、Walkthroughと同じくtyped
referenceを既定で使います。

`comment list`は未解決を既定として`unresolved` / `resolved` / `all`をページング列挙し、各threadの
root post preview、post件数、最新head時点のOutdated判定を返します。`hasMore`なら`nextOffset`から
続けて取得し、完全なthreadは`comment get`で読みます。listと通常の`comment get`はPR本文を省略し、
本文が必要な場合だけ`comment get --include-pr-body`で最新の同期済み本文を取得します。複数threadを
扱うAgentは同じPR本文を一度だけ取得し、そのPRの全threadで共有します。
`comment get`は最新PRのtitle、base/head、serviceが導出したplacement、対象commitのbounded source
excerptを返すため、AgentはOID比較でOutdatedを推測しません。

`comment get --live`はGitHubの現在値とcacheの差をread-onlyで確認し、DBを更新しません。`pr sync`はGitHub上の最新PR状態を取得し、任意の`commentUpdates`を同じSQLite transactionで反映します。保存先がdirtyでも同じrepositoryのcleanなworktreeを`--repository`で選べ、確認済みの未追跡fileだけは`--allow-untracked`で許可できます。local branchがGitHub headより単にbehindな場合や最終同期後にforce-pushされた場合はcheckoutを変更せず同期します。`comment create`は非冪等です。`pr sync`と`comment reply`は任意の冪等keyを受け、`comment edit`は同じpostの完全置換なので安全に再試行できます。

`rvw agent ping/status --json`はsocket path、接続結果とOS error詳細、期待／接続先DB、選択transport、
fallback理由を表示します。人向け出力にも同じ診断項目を表示します。`RVW_AGENT_SOCKET_PATH`を明示した場合は
そのsocketを必須とし、接続失敗やDB不一致をdirect
databaseへfallbackせずerrorにします。未指定時だけ、request送信前の接続失敗をdirect databaseへ
fallbackできます。

詳細は[CLI protocol](docs/cli-protocol.md)と[実装仕様](docs/implementation-spec.md)を参照してください。

## 0.x compatibility

CLI command / flag、`rvw://` URI、machine-readable JSON protocol、bundled Skillとのprotocolは、0.xでも
互換性を意識するsurfaceです。breaking changeが必要な場合はprotocol versionを進め、同梱Skillと文書を
同じreleaseで更新します。SQLite schema、data directory内layout、`src/` moduleはpublic APIではなく、
直接操作・importする前提を置きません。詳しくは[0.x compatibility](docs/compatibility.md)を参照してください。
最初のpublic protocolはversion 1とし、公開後はversion番号を再利用しません。

## Issues and contributions

bug reportとfeature suggestionは[GitHub Issues](https://github.com/a9n-shoji/rvw/issues)で歓迎します。
個人で保守しているため応答や修正時期は保証せず、Pull Requestは原則として募集していません。詳しくは
[Contributing](CONTRIBUTING.md)を参照してください。security issueはpublic Issueへ書かず、
[Security policy](SECURITY.md)の案内に従ってください。

maintainer向けのversion、tag、npm staged publishing、障害対応手順は
[npm release runbook](docs/releasing.md)にまとめています。

## 開発

source checkoutでは、GitHub接続や保存済みPRを用意せずにrepository規模のviewerを確認できます。

```bash
pnpm demo
```

このデモは小さなE2E fixtureとは分離され、現在のcheckoutにある直近6件のfirst-parent commitを
一つのsynthetic PRとして表示します。tree、文書、diff、検索はworktreeではなく実際のGit objectから読み、
100件以上の実在file、複数commit、変更外のtest・document・Skill、初期commentとWalkthroughを含みます。
browserを自動で開かない場合は`pnpm demo -- --no-open`、portを変える場合は`RVW_DEMO_PORT`を指定します。
デモを停止するには起動したterminalでCtrl+Cを押してください。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:e2e
pnpm build
pnpm test:package
```

通常テストは実Git binaryとfake GitHub adapterを使い、GitHub認証やnetworkを必要としません。
`test:package`はclean buildと実tarball作成を行い、一時directoryへinstallしてrepository checkout外から
CLI、migration、frontend、bundled Skillをsmoke testします。CIはmacOS、Linux、Windowsでpackage smokeを
実行しますが、通常CIからnpmへ公開しません。

## データとセキュリティ

SQLite DBはOSのユーザーデータdirectoryに保存され、`rvw doctor --json`の`databasePath`で実際の場所を
確認できます。DBにはlocal repository path、同期済みPR metadata/body、コメント、Walkthrough、theme
設定を保存します。review対象repositoryには旧sourceを保持する`refs/rvw/` Git refを作成します。GitHub
credentialはGitHub CLIが管理し、rvwのDBへコピーしません。

既定DBのdirectory/fileは新規作成時だけ`0700` / `0600`へ設定し、既存pathはownerとmodeを検証して
安全ならchmodしません。明示的に管理する別pathは`RVW_DATABASE_PATH`で指定でき、この場合rvwは既存pathを
chmodしません。存在しないdirectory/fileは作成時のmodeだけで`0700` / `0600`にし、既存pathが推奨modeで
なければ`doctor --json`にwarningを表示します。通常起動したviewerは`0700`の一時directory内へ
`0600`のdatabase別Unix socketを提供し、Agent CLIは可能ならそのprocessへ
書き込みを依頼するため、AgentへDB directoryの直接write権限を渡す必要がありません。同じsocketでは
atomicなowner lockを取得した一つのNode processだけがlistenし、owner終了後にfollowerが引き継ぎます。
`rvw doctor --json`はmode/ownerだけでなくwrite transactionとAgent疎通も報告します。

ローカルHTTP serverは`127.0.0.1`だけへbindしてHost / Originを検証し、write APIは
`application/json`だけを受理し、CORSを有効にしません。コメントと返信はUTF-8 GFM Markdown sourceとして
保存し、raw HTMLをsanitizeします。外部画像は取得せず、repository相対画像だけをexact commitから取得します。
CLIとfrontend bundleに含まれる第三者softwareのlicenseはpackage内の
`dist/cli-THIRD_PARTY_NOTICES.txt`と`dist/web/THIRD_PARTY_NOTICES.txt`へbuild時に収録します。

## License

[MIT](LICENSE)
