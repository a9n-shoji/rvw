対象は `c45bc91f4a0cfd071c3be3622eb6418059e236ff..a2f016c5e90886cce769aa0990c6a05c7ce02ae9` の PR 全体。参照座標は変更後の `a2f016c5e90886cce769aa0990c6a05c7ce02ae9` に統一する。プログラミング、TypeScript、Promise、HTTP、ローカルプロセスを知っている読み手に、日本語で説明する。

推奨は、ファイル間のつながりを示す Structure 一つ、順序を追う Walkthrough 二つ、細部への直接参照。最初の入口には「終了中のプロセスがあっても、次の open が起動先を確定できるまで」を勧める。`src/cli/main.ts:594–633` のループに、既存プロセスへ依頼する場合と自分で起動を引き継ぐ場合が並び、変更の中心をすぐ確認できる。

ここで runtime は、同じデータベースに対する PR 処理とローカル HTTP 画面を提供するプロセスを指す。ソースの `Runtime` は、そのプロセス内でデータベースやサービスをまとめたオブジェクト。予約は、画面がまだ接続していなくても進行中の open を記録しておくための値であり、データベースを使うプロセスを一つに絞るロックとは異なる。

一つ目の Walkthrough は「誰が次の接続先を作れるか」、二つ目は「既存の接続先が PR 取得の途中で消えないのはなぜか」を扱う。前者は複数プロセスの起動と終了、後者は一つのプロセス内の予約と時計が中心になる。一つにまとめると、新しいプロセスを作る経路と既存プロセスで URL を返す経路を同時に覚える必要がある。共通する `viewer.open` の停止エラーだけは、発生側と受信側の接点として両方で最小限示す。追加の挙動 Structure は、同じ順序を別記法で繰り返すため提案しない。

ファイル図は PR 全体の構成に含める。凍結済み composer の規約でも必須であり、今回は二つの説明を実装位置へ戻す用途がある。ただし読む順番を定める図ではない。以下の brief は未生成の提案であり、rvw のデータには保存していない。`runtime-handoff-before.json` も内容候補のみ。既存 Artifact の一覧・本文、protocol、transport は調べておらず、公開済み URI はない。必要なファイル図は提案として含めたが、保存済みの図としては未充足。

**内部 brief A — Walkthrough**

- authoring authority: 題材は「終了中のプロセスから次の open への引き継ぎ」。中心の問いは、旧プロセスが依頼を受けなくなった後、新しい CLI が既存の URL を得るか自分で起動できるまで何を繰り返すか。時間的な順序と条件の違いを文章でつなぐ。
- scope.include: `startBackgroundOpen` の入口、`acquireRuntimeOrReuseExisting`、`closeOwnedRuntime`、変更されていない socket のロック処理、結果を受ける `runOpenWorker`、停止エラーの厳密な識別、近接するテスト。
- scope.exclude: PR 取得そのものの内容、予約の二段階化、ブラウザの全 IPC 手順、全 socket プロトコル、クラッシュ後の古い inode の回収手順、一般の Agent 操作。
- mustEstablish（検証する候補）: 旧プロセスは HTTP と Runtime を閉じるまでロックを保持する。再試行のたびに取得を試す。取得できなければ候補を閉じて既存プロセスに `viewer.open` を送る。停止を表す特定エラーだけを握り直し、別 DB やそれ以外の例外は失敗を返す。`owned` の結果だけが呼び出し側で新しい Runtime 初期化へ進む。これらを brief の結論として信用せず、実装とテストから再検証する。
- diagramQuestion: 一回の取得失敗が、どの条件で既存 URL の利用に終わり、どの条件で取得の再試行に戻るか。候補は flowchart。各分岐と待機位置は producer がソースで確定する。図のために全エラーを「再試行」へまとめない。
- shared: `owned` は今回の呼び出しが socket のロックを保持する結果、`reused` は既存プロセスから URL を受けた結果。`runtime-stopping` は停止を示す文字列で、単に `PROCESS_FAILED` なら再試行するわけではない。
- doNotDuplicate: brief B が予約の `opening` / `startup` と接続確認を説明する。ファイルの配置は brief C の図に残す。
- candidate evidence: `src/cli/main.ts:237–241,381–411,574–633,714–755`; `src/server/agent-socket.ts:785–814,1000–1040,1054–1099`; `src/server/start-server.ts:78–104`; `test/unit/viewer-lifecycle.test.ts:483–565`; `test/unit/agent-socket.test.ts:657–693`。

**内部 brief B — Walkthrough**

- authoring authority: 題材は「PR の取得が遅くても、返す前の URL を接続待ち期限で失わない」。問いは、既存プロセスへの `viewer.open` が PR を取得している時間と、返した URL をブラウザが開く時間をどう分けるか。`reserve → await openPullRequest → arm → heartbeat` の順に説明する。
- scope.include: `createRuntimeAgentSocketHandler`、`RunningServer` が渡す予約操作、`ViewerLifecycle.pendingViewers`、期限を選ぶ処理、HTTP heartbeat が予約 ID を消費する入口、失敗時の予約削除、対象テスト。
- scope.exclude: socket ロックの選出・解放、ブラウザ内の画面表示、PR データ更新全体、sleep 復帰の全設計。
- mustEstablish（検証する候補）: PR 取得前に `phase: opening` の予約を作る。この値には deadline がない。PR 取得の完了後に `armViewerReservation` が `phase: startup` と期限を設定する。通常の期限計算と期限切れ削除は `startup` のみに適用する。予約がある限り空の画面一覧を理由に終了するタイマーへは進まない。HTTP heartbeat で予約 ID を削除し画面 ID の時刻を更新する。取得失敗なら予約を取り消す。タイマーの遅延補正があるため、「壁時計の 30 秒で常に終了」とは書かない。
- diagramQuestion: 一つの予約に期限がない時と期限がある時の違い。候補は小さな stateDiagram。`opening` と `startup` は実装の値だが、heartbeat 後は別 Map へ記録するため、予約がそのまま第三の enum 状態になるように描かない。
- shared: 予約 ID と画面 ID は別。`arm` はタイマーを使う予約に切り替える操作。`startupTimeoutMs` の既定値は 30,000 ms。停止済みなら予約操作を拒否し、`runtime-stopping` を返せる。
- doNotDuplicate: その停止エラーを受けた新しい CLI の再試行は brief A。独立した説明としては予約の終了までで止める。
- candidate evidence: `src/cli/main.ts:462–502`; `src/server/start-server.ts:78–104`; `src/server/viewer-lifecycle.ts:17–18,49–80,98–168`; `src/server/app.ts:159–174`; `test/unit/viewer-lifecycle.test.ts:121–159,416–480`。

**内部 brief C — file-map Structure**

authoring authority: 範囲はこの PR の「open の引き継ぎと画面の接続予約を実装・接続・検証するファイル」。問いは、その処理がどのファイルにあり、呼び出しや型、コールバック、テストによってどうつながるか。origin 候補は `src/cli/main.ts`。図全体の共通実行入口という意味にはしない。一つの Node は一つのファイルとし、全てにファイル全体の anchor を置く。以下は producer が再検証する候補であり、完成したグラフではない。

| candidate path                       | 図に入れる理由                                                            |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `src/cli/main.ts`                    | open の選択、ロックの再取得ループ、予約の呼び出し、終了時の順序が同居する |
| `src/server/agent-socket.ts`         | プロセス間の `viewer.open`、ロック取得、受付停止と解放を実装する          |
| `src/server/start-server.ts`         | HTTP を起動し、画面の接続を追うオブジェクトを作って予約操作を公開する     |
| `src/server/viewer-lifecycle.ts`     | 予約、画面の接続時刻、タイマー、最後の画面の終了通知を保持する            |
| `src/server/app.ts`                  | HTTP ヘッダーの画面 ID と予約 ID を読み、heartbeat / release を呼ぶ       |
| `src/application/runtime.ts`         | データベースとサービスを作り、`close` でデータベースを閉じる              |
| `src/application/rvw-service.ts`     | `openPullRequest` を実装し、参照と作業ディレクトリから開く PR を求める    |
| `test/unit/viewer-lifecycle.test.ts` | 予約の期限、停止エラーによる再試行、終了操作の順序を記述する              |
| `test/unit/agent-socket.test.ts`     | 実際の socket とロックを使う引き継ぎケースを記述する                      |

mustEstablish: 各 path が同じ sourceOid にあり、ファイル数と Node 数が一致すること。候補となる直接関係は以下。import だけから呼び出しを推測しない。

| from → to                                        | predicate 候補と evidence                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `main.ts → agent-socket.ts`                      | socket 開始と既存 open を呼ぶ：`main.ts:600–616`                                 |
| `main.ts → start-server.ts`                      | `startServer` を呼び、返された予約操作を使う：`main.ts:481–498,727–734`          |
| `main.ts → runtime.ts`                           | `createRuntime` を既定 factory に設定する：`main.ts:758–763`                     |
| `main.ts → rvw-service.ts`                       | `openPullRequest` を呼ぶ：`main.ts:481–484`                                      |
| `runtime.ts → rvw-service.ts`                    | `RvwService` を生成する：`runtime.ts:21–25`                                      |
| `start-server.ts → viewer-lifecycle.ts`          | 接続終了の callback を渡して生成し予約操作を呼ぶ：`start-server.ts:34–53,78–104` |
| `start-server.ts → app.ts`                       | `ViewerLifecycle` を渡して HTTP app を作る：`start-server.ts:54–58`              |
| `app.ts → viewer-lifecycle.ts`                   | HTTP から heartbeat / release を呼ぶ：`app.ts:159–174`                           |
| `viewer-lifecycle.test.ts → main.ts`             | 取得再試行と終了順を検証する記述：テスト `483–565`                               |
| `viewer-lifecycle.test.ts → viewer-lifecycle.ts` | PR 取得中と接続待ちの期限を検証する記述：テスト `139–159`                        |
| `agent-socket.test.ts → agent-socket.ts`         | 停止と解放を使って引き継ぎを検証する記述：テスト `657–693`                       |
| `agent-socket.test.ts → main.ts`                 | `acquireRuntimeOrReuseExisting` の結果を検証する記述：テスト `677–689`           |

presentation: ファイルを探す用途なので特別な spatial presentation は要求しない。図のための Region や経路を足さず、producer の検証後に `presentation: null` でよい。共有する語と境界は A/B に従う。図は実行順序を説明せず、読み手はどのファイルからも確かめられる。

scope.exclude: UI コンポーネント、データベースの schema、一般の Agent 操作、Git/GitHub の全実装。変更された四つの設計文書と CHANGELOG は、今回の二つの挙動を文章で更新したものとして diff を確認したが、処理のつながりを増やさないため Node にしない。設計の表現差を調べる場合はその diff を直接読む。ブラウザの予約 ID 送信側はこの図に展開せず、HTTP 入口を境界として明示する。

細部は直接読む方が速い。明示 port の不一致は `main.ts:469–480`、foreground の既存プロセス拒否は `main.ts:666–679`、`--no-open` が予約 ID を送る経路は `main.ts:504–571`、送信後に結果が分からなくなった場合の例外は `agent-socket.ts:495–511,565–619`、遅れたタイマーの補正は `viewer-lifecycle.ts:132–149` が入口になる。

brief A を内容候補にした後も、B の二段階予約と C のファイル単位は維持する。A が確認したのは、socket の開始オブジェクト自身が自動で昇格する方式ではなく、CLI が開始操作を呼び直す方式だった。この点を B に持ち込む必要はなく、C では `main.ts` から `agent-socket.ts` への呼び出しに置く。これにより三つの面の重複は、同じコードに戻るための短い接点に留まる。読む順番やレビュー範囲を保証する提案ではなく、最終的な根拠は指定コミットのコードにある。
