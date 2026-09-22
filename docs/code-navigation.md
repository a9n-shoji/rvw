# Code navigation

## 調査結果と接続点

基点は origin/main `11a3673`。`GitClient.tree()` は `git ls-tree -r -z --long`、
`readDocument()` は source commitのtree entryを解決して `git cat-file blob` を読む。
UTF-8、1 MiB制限、CRLF正規化は既存文書と共通。repository searchはcommit指定の
`git grep`であり、working treeやnode_modulesへ探索範囲を広げない。

`DocumentWorkspace`のtab identityはpath、exact snapshotは`sourceOid`。
同一paneの同じpathは既存tabを置き換え、historyに元のsourceと位置を残す。
`PullRequestReviewScreen.navigateToDocument()`に`comparisonPolicy: exact-source`と
line destinationを渡せば、globalなreview rangeを変えず対象paneに全文を開ける。
Quick OpenやMarkdown linkと同じ通常click→左、Cmd/Ctrl+click→右を使う。
Back/Forwardも既存reading historyを使い、専用Viewerや別履歴を追加しない。

`DocumentViewer`の全文/Fileとdiff/FileDiffは`@pierre/diffs`。
既存の`onTokenClick`が行番号・UTF-16文字位置・diff側を渡すため、DOMを書き換える
identifier rendererは不要。Shiki tokenはクリック位置の取得だけに使い、symbolかどうかは
serverでTree-sitterのcaptureと照合する。削除側はold ref、追加側はnew refを渡す。
未対応言語にはtoken interactionを追加しない。

APIは既存HonoのHost検証下に置き、RvwServiceでPRとsource commitを検証する。
SQLiteはreview記録の永続化を担うが、再生成可能な索引はservice単位のmemory cacheで足りる。
DB migrationは追加しない。将来のdisk cacheはreview DBと寿命の異なる派生cacheとして検討する。

## 方式比較

| 方式                                                 | セットアップ・Ruby/Rails                                  | TS/JS・精度                                                         | 配布・サイズ・platform                                           | 索引・Git適合・保守                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Tree-sitter WASM + tags query（採用）                | 同梱で利用者設定不要。汎用Ruby構文を抽出、Rails起動不要   | grammar/query追加で拡張可能。名前一致候補、semanticな呼び先は未確定 | runtimeと必要grammarのみ同梱。OS/CPU別native binary不要          | Git blobを直接parse。blob再利用可能。grammar/query更新の互換性検証が必要                                    |
| Universal Ctags                                      | Rubyを含む多言語。別途installは制約違反なので同梱が必要   | 定義中心。reference tagは言語依存でsemantic解決とは異なる           | 実行binaryのOS/CPU別配布とライセンス対応が増える                 | snapshotを一時file等へ渡すadapterが必要。blob単位cacheは可能だが今回のJS配布には不利                        |
| SCIP                                                 | index formatでありparserではない。scip-rubyはSorbetベース | 型情報がある対象ではより精密。TSも別indexer                         | indexerごとのbinary/toolchain・project依存がある                 | commit一致の完成済みindexを取り込む将来providerには適する。初回open時の無設定解析には重い                   |
| Stack graphs等の埋め込みengine                       | parserに加えて言語ごとのbinding/name-resolution規則が必要 | 対応言語の名前解決を改善できるがRails magicは自動的には解けない     | Rust/native/WASM等の追加adapterと配布検証が必要                  | blob単位の部分graphを再利用できる。公式repositoryは2025-09-09にarchive済み。Ruby対応と規則保守がMVPを超える |
| TypeScript language service等をlibraryとして埋め込み | TSではserver起動不要。ただしRubyの解決にはならない        | virtual filesystem/project hostと依存を与えればTS/JSの精度が高い    | TypeScript compilerをruntime同梱すると増量。Rubyは別engineが必要 | Git snapshot host実装、tsconfig/module resolutionと依存の整合性管理が必要                                   |
| git grepによる名前検索                               | 追加設定なし。全言語で使える                              | コメント/文字列/定義以外も一致                                      | 追加packageなし                                                  | 既存searchを利用できるが定義識別ができず、今回の導線には不足                                                |

比較は以下の一次資料と、実際のnpm package内容の確認に基づく。

- [Tree-sitter code navigation](https://tree-sitter.github.io/tree-sitter/4-code-navigation.html)
- [Web Tree-sitter / WASM distribution](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web)
- [Ruby upstream tags query](https://github.com/tree-sitter/tree-sitter-ruby/blob/v0.23.1/queries/tags.scm)
- [Universal Ctags reference tags](https://docs.ctags.io/en/latest/output-tags.html)
- [scip-ruby supported configurations](https://github.com/sourcegraph/scip-ruby#supported-configurations)
- [Stack graphs](https://github.com/github/stack-graphs)
- [TypeScript language service API](https://github.com/microsoft/TypeScript/wiki/Using-the-Language-Service-API)

## 実装範囲

Rubyのclass、module、method、singleton method、aliasを公式tags queryで抽出する。
constant assignmentだけ小さなTree-sitter queryを追加する。Ruby parser、scope、receiver、
継承、autoload、Railsの名前解決器は実装しない。Ruby grammarのreference captureを
クリック位置の検証に使うが、local-variable resolutionは行わない。
`#is-not? local`をsemanticな証拠として扱わず、usages APIにも公開しない。

対象はRuby（`.rb` / `.rake` / `.gemspec` / `Gemfile` / `Rakefile`）、JavaScript/JSX（`.js` / `.jsx` / `.mjs` / `.cjs`）、
TypeScript（`.ts` / `.mts` / `.cts`）、TSX（`.tsx`）。
JS/TSは公式tagsに小さなsyntax queryを足し、関数・class・method・変数・type/interface/enumとidentifier位置を抽出する。
ReactはJSX/TSXの構文として扱う。function/arrow component、memo等へ代入した変数、JSX tagから探索できる。
全文またはdiff上のidentifierをCmd/Ctrl+clickすると小さな定義候補panelを開く。
候補は1件でも「定義候補」とし、利用者が選択する。件数だけを根拠にexact扱いして
自動ジャンプすることはしない。クリックした宣言自身はpath/行/列で除外し、別の宣言や別pathは残す。
通常clickで左、Cmd/Ctrl+clickで右へ開く。modifierを押している間は名前上のcursorをpointerにする。
不確実性は「定義候補」の表記で示し、毎回の注意文は表示しない。
候補は宣言行のpreviewを持つ。候補buttonは↑↓/Home/End/Tab/Enterで操作でき、Escapeでpanelを閉じて元のpaneへfocusを戻す。
portalの固定位置popupでコードのlayoutを変えず、外側click・scroll・resizeでも閉じる。
現MVPの探索開始はpointer操作。keyboardからのsymbol探索は今後の改善対象。

## 境界とAPI

- `tree-sitter-tags.ts`: 同梱runtime/grammar/queryをロードし、textからpathを持たない`BlobSymbols`を返す。
- `ParserWorkerClient`: 遅延起動する専用worker。解析をHTTP event loopから隔離し、timeout時に破棄して次回再起動する。
- `GitSymbolIndex`: blob cacheとcommit内path配置を分離し、同名定義をqueryする。
- `CodeNavigationProvider.definitions`: query境界。現在実装は一つだけ。
- `NavigationTarget`: exact `DocumentRef`、名前、構文kind、宣言行preview、1-based行/UTF-16列。
- `DefinitionResult`: `possible` / `none` / `unsupported` / `unavailable`、候補、`partial`、
  `issues`（不完全さの理由）、`skippedFiles`、`truncated`。exactの根拠を持つproviderができるまではexact結果を定義しない。
- `ReferenceResult`は未使用になるためまだ追加しない。Rails augmentation registryやprovider選択UIも作らない。
- `GET /api/pull-requests/:id/definitions?sourceOid=...&path=...&line=...&column=...`
  はsource位置を受け取り、server側captureの名前を使う。任意文字列の曖昧検索APIにはしない。
- UIは結果を既存repository-file navigationへ渡す。遅延responseによる自動navigationは行わず、
  文書・commitの切替時はViewerとともにpanelを破棄し、Back/Forwardでも閉じる。

## 言語パックの境界

Ruby・JavaScript・TypeScript・TSXはすべて同じdata-only pack契約で標準同梱する。
`src/shared/navigation-packs/*.json`が対象拡張子、basename、family、grammar asset、query assetを宣言し、
`navigation-packs.ts`が登録する。拡張子判定・parser loader・索引family・配布buildはこの登録を共通参照し、
parser/index/UIにRubyやReact専用の分岐を持たない。query追加も`.scm` fileへ分離する。
同じfamilyのJS/JSX/TS/TSXは横断して候補を探す。Rubyとの同名衝突は混ぜない。

現時点ではbuild時登録の標準packに限る。利用者が実行時に追加・削除するCLI、download/update、
外部manifest検証、配布元のintegrity確認は未実装であり、ユーザー向けアドオン機能が完成したとは扱わない。
後続で同じ契約を利用したpack discoveryとUIへのcapability配信を追加できる。

## 精度とRails/Reactでの期待値

model/controller/Concernのclass/module宣言、明示的なmethod定義、constantから探索を始められる。
receiverの型、namespace、instance/class method、visibility、継承、include順序は照合しない。
同名methodはすべて候補になる。operator methodやsymbol形式のaliasはクリック／名前一致ができない場合がある。class reopenは複数箇所として表示される。
定義がrepository外のgemにある場合や、`define_method`、`method_missing`、`delegate`、`scope`、
association、route/view/partial等のDSLから生成される場合は解決できない。
JS/TSでもimport alias、default exportの別名、re-export、module resolution、receiver型、lexical scopeを解決しない。
名前が一致しないaliasは候補なしになり、同名のlocal variableや別moduleは候補に混ざりうる。
Gitに記録されていないnode_modulesやworking treeは読まない。React props/HOCのsemanticな追跡はしない。
ERB、Vue SFC等の未対応言語とFind usagesは対象外。従来のviewer/searchは継続利用できる。
構文エラーを含むfileは回復できたcaptureを返して索引不完全を明示する。

## 性能とcache

初めてsymbolをqueryした時だけ、そのcommitの同じfamilyのfileを`git cat-file --batch`で最大32 blobs / 4 MiBずつ読む。
full OID・型・サイズ・出力境界を検証し、既存文書と同じdecode/CRLF正規化を使う。viewer open時に全repositoryを
parseしない。blob metadataは`language pack ID + blobOid`で共有し、path/commitを含めないためrename/copyや
別commitで再利用できる。commit indexはrepository path + sourceOid + familyごとに定義とpathを結び直す。
parser/queryは固定versionで、process終了で全cacheを破棄するためversion間の混線はない。

- blob cache: JSON換算16 MiB、最大4,000 entries、LRU。
- commit index: 最大4 snapshots。各snapshotは最大2,000 files / source合計16 MiB / 50,000 definitions。
- 1 fileは既存viewer同様1 MiBまで。symlink/submodule/binaryは解析しない。
- 1 blobは最大10,000 name captures、parse/queryのprogress callbackで100ms budget。
- 1 responseは先頭100候補まで。上限到達はUIで明示する。
- 同一snapshotの作成を共有し、snapshot作成を直列化、pending snapshotは4つまで。
  active queriesは8、workerの待ち行列は16まで。busyは429、worker失敗は503で明示して再試行できる。
- workerは1 fileあたり5秒で強制終了、idle 30秒で解放。V8 old generationは128 MiBに制限する。
  parserの100ms budgetや索引の10秒budgetを超えた結果は理由付きpartialとし、恒久的なnegative cacheにしない。
  完了済みblobを再利用して再試行できる。batch Git readは10秒timeout、終了時はabortしworkerも破棄する。
  Git/loader失敗はerrorを返し、失敗したsnapshotをcacheしない。
- unchanged blobでも新commitのtree列挙とpath結合は必要。変更blobは全体parseする。
  Tree-sitterのtree-edit incremental parseはcommit間差分管理が必要なのでMVPでは使わない。
- cacheサイズはserialized payloadの上限であり、JS object/WASM実メモリー上限そのものではない。
  巨大repositoryのlatency/ピークRSSは継続計測対象。

## 配布

devDependencyに `web-tree-sitter@0.27.0`、`tree-sitter-ruby@0.23.1`、`tree-sitter-javascript@0.25.0`、`tree-sitter-typescript@0.23.2`を固定追加。
TypeScript packageは開発時に`tree-sitter-javascript@0.23.1`も推移依存として持つ。
開発時の推移依存として`node-addon-api@8.9.2`と`node-gyp-build@4.8.4`も追加されるが、配布物には含めない。
各grammar packageのnative install scriptは明示無効化。native bindingやprebuildをruntimeへ取り込まない。
esbuildでadapterをCLI、parserを専用`dist/parser-worker.mjs`へbundleし、共通runtime WASMと登録packのgrammar/query assetsだけを
`dist/navigation/<pack ID>`へcopyする。upstreamライセンスをCLIの第三者noticeへ含める。
利用者のnpm installは従来同様runtime dependenciesなし。browserにparser/WASMを配らない。

## 次の拡張とdogfood

まずRailsの実PRで、候補から必要なfileへ辿れる割合、同名候補の多さ、初回待ち時間、Back後の
読解継続、左右paneの使い分け、誤ってexactと受け取られないかを観察する。
特にcontroller→modelやConcernへの探索で、既存repository searchより操作が減るかを確認する。

次はkeyboardからの起動、同名候補の文脈強化、ユーザー向け言語pack管理を検討する。
Find usagesは必ずpossible usagesとしてsyntax captureと文字列検索を区別して設計する。
実測で必要ならpersistent blob cacheを検討する。
Rails augmentationはDSL名と宣言位置を小さな追加候補として扱い、semanticな呼び先を捏造しない。
SCIP等の精密providerはsource commitが一致するindexを利用できる場合の後続案とする。

## 検証記録（2026-09-22、macOS / Node 24.15.0）

実Git fixtureでcommit分離、rename/copyのblob再利用、dirty checkout無視、並行queryのparse共有、
複数候補、候補なし、comments/strings、CRLF/日本語/UTF-16、構文エラー、大きいfile、候補上限、
Git error後のretryを検証した。
JS/TS/TSXの宣言・JSX tag・型・generic構文、grammar変更時のblob cache分離、JS/TS横断候補とRubyとの分離も検証した。配布用CLIを別processで起動するPlaywright testでは、
削除側→旧path/旧commit、追加側→rename後のpath、全文、stacked/split diff、右pane、Back、
複数候補のキーボード選択、未対応言語、API入力検証を確認した。
worker hang/timeout/restart/idle解放、queue上限、shutdown、batch blob検証、parse-limit後のretryも検証する。
macOSではControl+clickがOSのcontext menu操作になるためCmd+clickで検証する。

251 Ruby files（250 classes × 40 methods、10,250 definitions、caller 1 file）の合成fixtureを
専用workerとbatch読み取りを使って一回測定した結果は、cold query 354ms、同commit warm query 12.1ms、rename後26.3ms。
partial=false。改良前のcold 2,506msから約86%短縮した。同一条件の単発測定で、保証値ではない。
rename/copy/変更のないcommitで追加parseやblob readが起こらないことはintegration testで確認する。
測定processのRSSは約237 MiBで、Node/tsx/worker/WASMを含む総量。
これは実Rails repositoryの保証値や増分メモリー量ではない。

同じnpm pack（prepackなし）条件でmain `11a3673`と比較した値:

| 内容          |         main |       実装後 |              増分 |
| ------------- | -----------: | -----------: | ----------------: |
| tarball       |  4,268,374 B |  5,007,715 B | 約739 KB（17.3%） |
| 展開後package | 21,356,609 B | 27,420,692 B |         約6.06 MB |

追加WASM実体はRuby 2,106,352 B、JS 411,770 B、TS 1,413,849 B、TSX 1,445,638 B、runtime 209,613 B。
JS/TS/TSXだけの追加分は展開後3,271,257 B、個別gzip合計338,195 B。
package smokeの展開後budgetは25 MiBから28 MiBへ改定し、圧縮後budgetは6 MiBのまま維持する。上記サイズにはsource mapとnoticeを含む。
後続の微小なUI/docs変更やpackの圧縮条件で数KB程度変動しうる。
開発時のRuby grammar packageは約30.8 MBだが、配布物にはそのnative prebuildやC sourceを入れない。
package smokeではruntime dependenciesなしのoffline installとWASM/query同梱を検証する。

完了したcheck:

- `pnpm check`: TypeScript / ESLint / Prettier成功。
- `pnpm test`: 64 files / 720 tests成功。
- browser regression: 全185ケースを実行。184件成功、残る既存copy testのlocatorを識別子token分割に対応させ、navigation 5件とcopy 1件の再実行が成功。Cmd hover、自己候補の除外、候補100件/640px/長いpath、React JSX/TSXも確認。
- `pnpm build`: CLI / web / WASM assetsのbuild成功。
- `pnpm test:package`: offline install、runtime依存なし、同梱asset、license notice、packageサイズ上限を検証。

実Rails PRの人間によるdogfood、およびLinux/Windows実機での操作確認は未実施。

## 操作できるRuby/Reactデモ

`pnpm demo:navigation`（ブラウザを自動で開かない場合は`pnpm demo:navigation --no-open`）。
portは既定43119、`RVW_NAVIGATION_DEMO_PORT=0`で自動割当。
一時Git repositoryにcontroller/model/service、React componentsと実際のrenameを含む履歴を作り、通常のRvwService・GitClient・parser workerで動作する。
GitHubのPR metadataだけをローカルで与え、GitHubへの接続やRuby/Railsのinstallは不要。終了時に一時repositoryを削除する。

1. `orders_controller.rb` の変更後 `Checkout` をCmd/Ctrl+click。
2. Orders/Refundsの候補を確認し、Ordersの候補をCmd/Ctrl+clickして右paneへ開く。
3. `InventoryReservation` / `reserve!` から在庫serviceへ辿り、Backで戻る。
4. controllerの変更前からは旧path、変更後のserviceからはrename後のpathへ移る。

5. `frontend/CheckoutPage.tsx` の`Button`からTSX/JSXの候補を表示して右paneへ開く。

デモは合成Rails/React例であり、実Rails PRでの人間によるdogfoodとは区別する。
