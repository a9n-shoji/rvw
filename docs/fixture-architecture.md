# Fixture architecture

rvwのfixtureは、失敗原因を局所化できる小さな契約と、ひとつの変更を縦断して読む受入シナリオを
混同しないため、次の4つへ分ける。

| Fixture   | 用途                                                                                                  | 実行場所                                              |
| --------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| contract  | 単一UI/API状態、binary / too-large / missing、comment placement、test-only mutation                   | 通常のPlaywright server。`RVW_FIXTURE_SCENARIO`省略時 |
| realistic | deterministicな注文service PRをPR本文、Git history、source、comment、Walkthrough、Structureとして縦断 | `pnpm demo`と`realistic-fixture.spec.ts`              |
| stress    | 100 comments、long document、20 / 100 / 500-node graphと各graph shape                                 | unit test、Viewer E2E、`viewer-performance.spec.ts`   |
| dogfood   | 現在のrvw checkoutにあるcommitted Git objectsを読む任意の確認                                         | `pnpm demo:dogfood`、`pnpm test:dogfood`              |

fixture serverは`RVW_FIXTURE_SCENARIO=contract|realistic|dogfood`だけを受け付ける。未知の値はcontractへ
fallbackせず起動時に失敗する。通常のPlaywrightはcontract serverとrealistic serverを起動し、dogfoodは
起動しない。

## Realistic fixture

`test/fixtures/realistic/realistic-fixture.mjs`はOS temporary directoryへSHA-1 repositoryを作る。author名・
email、author / committer date、timezone、line ending、file mode、signingを固定する。さらにsystem / global Git
config、attributes、template、hooksを隔離し、commitには`--no-verify`を指定するため、networkとrvw repositoryの
HEAD / branch / local refs、host固有のGit設定を参照しない。正常終了、SIGINT / SIGTERM / SIGHUP、構築失敗時に
idempotent cleanupを行う。

PRはauthenticated request boundary、order aggregateとpricing、inventory / payment、idempotency、同一
transaction内のorder / outbox永続化、dispatcherとobservability、payment reconciliationという7つのreview
単位で進む。manifestはrepository / diff shape、change kinds、layer、comment state、Walkthrough、Structure、
rename / delete targetsを一箇所に集約する。

payment recovery candidateはremote authorization直後に登録するが、grace period中はlease対象にしない。
正常なorder commitではcandidateの完了をorder / outboxと同じtransactionに含め、workerはorder存在、確認済み
orphan、既にterminal、再試行すべき曖昧状態を明示的に区別する。provider固有のpayment statusはadapterで
`voidable` / `already-voided` / `captured` / `pending` / `unknown`へ正規化する。

actor-scoped idempotency keyはremote side effectより先にstable operation IDをclaimし、そのIDをorder IDと
payment provider keyに使う。completed responseはorder / outbox / recovery completionと同じtransactionへ書き、
完了記録だけが欠ける障害窓を作らない。advisory lockを保持する同じconnectionでこのtransactionを実行し、
`PostgresIdempotencyStore`が`TransactionRunner.runWithClient`へそのconnectionを渡すため、order存在確認を含めて
pool capacityが1でも追加connection待ちを起こさない。ただしprovider呼出し中もsession advisory lockとconnectionは
保持されるため、slow providerやretry burstによるpool占有はreview対象のtrade-offとして明示する。payload fingerprint、inventory reservationのretry重複、
reconciliationのattempt / last-outcome永続化はsynthetic PRのKnown trade-offsとして明示する。

fixtureを更新するときは、まずscenarioの意味を保ったままsourceとcommit progressionを変更し、その後に
semantic needleから作られるreferenceを更新する。手書き行番号は追加しない。builderのstartup validationと
`realistic-fixture.test.ts`は次をnamed invariantとして検証する。

- 別temporary directoryで同一commit OID、tree、changed-file manifestになること
- first-parent chain、base / head、file / diff shape、added / modified / renamed / deletedの存在
- Walkthrough reference ID、Mermaid binding、Structure origin / endpoint / source anchor、required nullable
  presentationのcurrent start / Node参照、primary backboneのexact Edge／derived Node数／connectedness、region非重複の整合性
- comment targetと作成commit、PR / Walkthrough quote、rename追従、delete後Outdatedの整合性
- baseと各commitにおける全relative importのclosureと、生成repository全体が`tsc --noEmit`を通ること
- Structure origin topology、sourceOid、presentationの有無に応じた初期projection、post reference / related commit、
  説明を支える主要sourceの存在
- 同じsource fileが複数Structure nodeから逆引きできること
- missing pathが明示的にmissingになること

## Contract and stress ownership

contractとrealisticが共有するorder-service source corpusはscenario-neutralな
`test/fixtures/order-service/order-service-sources.mjs`に置く。contractで配信する全repository sourceは
`test/fixtures/contract/contract-repository.mjs`がそのcorpusと明示的な補助sourceを統合し、未知pathを
拒否する単一providerになる。contractのWalkthrough dataは
`test/e2e/walkthrough-fixture.mjs`、Structure dataは`test/fixtures/contract/contract-structures.mjs`に置く。
`fixture-server.mjs`はHTTP behavior、selected
repository provider、fresh mutable comments / Walkthroughs / Structuresの橋渡しを担う。contract固有の
mutation endpointやbinary / too-large等のedge caseはrealisticへ複製しない。

Structureのsemantic anchorはprovider上で検証したneedleを公開し、E2EでもHTTP APIが返した同じ行範囲に
needleが含まれることを確認する。validator専用のfallback sourceは持たない。

stress generatorは`test/fixtures/stress/stress-fixture.ts`に置く。実務narrativeやrealistic manifestの件数を
増やすためには使わない。100-comment placement budget、100-node Structureの実Viewer操作、10,000-line文書の
deep-line navigation / searchは通常の`pnpm test:e2e`内で実行する。500-node graphはlayoutとfull render modelを
通常の`pnpm test`で検証し、いずれもCIから分離しない。

## Dogfood mode

`pnpm demo:dogfood`と`pnpm test:dogfood`は`createDogfoodFixture`を通して現在のcheckoutのcommitted objectsを読む。これはparserと
Git object readerを手元の実repositoryで確認するmodeであり、realistic acceptance contractではない。file数、
byte数、changed file数、PRの意味を通常の`pnpm test`で固定assertせず、専用CI jobでsmoke testする。必要なhistoryがなければ、取得すべきhistoryを
示すerrorを返し、network fetchを暗黙に行わない。tree / document / binary / rename reader自体は現在のcheckoutに
依存しないtemporary Git repositoryのunit testで固定する。

## README用の実画面

READMEの画像は、realisticデモの同じPR（`acme/commerce-service #418`）を読む二つの場面です。
Playwrightでデモを操作し、文書ペインを切り出して撮影します。
初回利用の手順は[利用ガイド](usage.md#デモで同じ疑問を追う)を参照してください。

Node.js 24.15.0以上、pnpm 11.21.0、Gitを使い、リポジトリのルートで実行します。

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm demo -- --no-open
```

別の端末で、デモを起動した直後に撮影します。

```bash
node scripts/capture-readme.mjs
```

ポートを変える場合は両方のコマンドに同じ `RVW_DEMO_PORT` を渡してください。
再撮影はデモをCtrl+Cで止めてから起動し直します。スクリプトは初期コメント13件を検証し、
個人のrvw保存先ではなく、この固定PRだけを操作します。コメントを投稿するので、同じデモへの二回目の実行は初期状態の検証で止まります。

撮影条件はChromium、ライトモード、画面1180 × 780 CSS px、倍率2、`ja-JP`、`Asia/Tokyo`です。
新しいブラウザコンテキストを作り、既存コメントをUIから折りたたみます。
上部バーとサイドバーを除く文書ペイン幅844 CSS pxを切り出し、文字がREADMEの幅で読めるようにします。
撮影中にDOMの文言やCSS、デモのコード・説明は書き換えません。
紹介するWalkthroughの本文・図ラベルはfixture側で日本語にしてあり、通常の `pnpm demo` でも同じ内容を読めます。
コード、参照ID、参照先は維持しています。投稿日時は撮影時点のものです。

| 出力                              | 場面と確認事項                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `docs/images/review-evidence.png` | 「決済承認後に注文を保存できなかったら」を読む。決済承認後の保存失敗について、処理と運用文書へのリンクがある |
| `docs/images/review-comment.png`  | 同じ説明から開いた復旧コードで `retry-later` を読み、再試行の期限と通知条件を行コメントで質問する            |

スクリプトはこの間に `決済の復旧処理` をCmd＋クリックして右ペインにコードを開き、
`復旧の運用手順` も読んでからコードへ戻ります。行番号は `return "retry-later"` の実際の表示行から取得します。
コメントの投稿と参照コピーをUIで実行し、コピー先が質問本文とそのコード行に対応することをAPIの読み取りで照合します。
撮影は参照のコピーまでです。Agentとの往復を試すには、通常の `rvw open` とSkillを使います。

題材の根拠は `test/fixtures/order-service/order-service-sources.mjs` 内の
`src/workers/payment-reconciliation.ts` と、`test/fixtures/realistic/realistic-fixture.mjs` 内の
`docs/runbooks/payment-recovery.md`、既成Walkthroughです。取り消し可能な決済だけを取り消し、
注文がある場合・既に取り消された場合・後で再試行する場合を分けます。
運用文書は試行情報の永続化が未実装であることと、外部から滞留を監視することを述べており、
画像の質問では、コードだけでは分からない再試行の期限と通知条件を尋ねています。

### 操作GIFの再作成

GIFは同じ操作中に撮った4場面（説明、コード、質問の入力、投稿）を13秒で順に表示します。
各場面の表示時間は3秒、3秒、4秒、3秒です。幅844 px、128色で保存します。
変換時だけPython 3とPillowが必要です。rvw本体や通常の撮影に依存関係は追加していません。

デモを再起動してから、空の一時ディレクトリを指定して実行します。

```bash
RVW_CAPTURE_FRAMES_DIR=/tmp/rvw-readme-frames node scripts/capture-readme.mjs
python3 scripts/compose-readme-gif.py /tmp/rvw-readme-frames
```

`docs/images/review-flow.gif` を出力します。4枚のPNGは一時ディレクトリに残るので、全場面を開いて確認できます。

画像更新時は静止画とGIFの全場面を実際に開き、README相当の幅で読めること、本文・alt・画像が一致することを確認してください。
READMEの画像URLは、画像を含むpush済みコミットの完全なSHAで固定します。再撮影した画像をcommit・pushしてから、そのSHAへURLを更新してください。未マージの画像を `main` のURLで参照しないでください。
READMEからの文書リンクも、案内する文書を含むpush済みコミットへの絶対URLにします。文書の更新時は、そのリンク先のSHAも見直してください。
詳細文書や画像はパッケージへ同梱せず、GitHub・npmとも同じ公開URLを参照します。
確認はローカルファイルの存在だけで済ませず、画像URLのHTTP応答と、GitHubで描画されたREADMEの画像・文書リンクも確かめてください。

参照解決、図の描画・ID・座標、コメント追跡、runtime・保存先の細則は
[実装仕様](implementation-spec.md)、[設計](architecture.md)、[CLI protocol](cli-protocol.md)を参照してください。
利用操作と復旧は[利用ガイド](usage.md)、開発・パッケージ検証は[Contributing](../CONTRIBUTING.md)にあります。
