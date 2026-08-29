import type {
  SourceAnchor,
  Structure,
  StructureEdge,
  StructureFixture,
  StructureNode,
} from "./model.js";

function source(path: string, startLine?: number, endLine?: number): SourceAnchor {
  return {
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
}

const commentWatchStructure: Structure = {
  id: "rvw-comment-watch-flow",
  title: "コメント監視フロー",
  scope:
    "RVWで新しいコメント投稿が作られてから、外部の監視タスクが永続カーソルで受け取り、受付応答とAgentの作業へつなぐまで。",
  initialFocus: "ordered-event-log",
  nodes: [
    {
      id: "human-comment",
      label: "人間がルートコメントまたは返信を作成する",
      description: "ViewerまたはCLIから作られる通常のレビュー投稿。Agent専用の状態ではない。",
      kind: "ユーザー操作",
      anchor: source("src/application/rvw-service.ts", 1327, 1367),
    },
    {
      id: "application-write",
      label: "Applicationがコメント書き込みを検証する",
      description: "HTTPとCLIが共有するApplication Serviceの書き込み境界。",
      kind: "アプリケーション",
      anchor: source("src/application/rvw-service.ts", 1327, 1367),
    },
    {
      id: "sqlite-comment",
      label: "SQLiteが通常の投稿を保存する",
      description:
        "コメントスレッドと投稿を通常のレビューレコードとしてトランザクション内へ保存する。",
      kind: "永続化",
      anchor: source("src/infrastructure/db/database.ts", 1127, 1166),
    },
    {
      id: "ordered-event-log",
      label: "DB全体で順序付けされた投稿イベント列",
      description:
        "投稿とは独立してシーケンスと最小限のトリガーを保持する。削除後も利用側が順序を再生できる。",
      kind: "概念",
      anchor: source("src/infrastructure/db/database.ts", 544, 569),
    },
    {
      id: "watch-application",
      label: "Applicationが不透明なカーソルを有限件のイベントページへ解決する",
      description: "DB識別子、カーソル位置、取得上限を検証し、次の不透明なカーソルを組み立てる。",
      kind: "アプリケーション",
      anchor: source("src/application/rvw-service.ts", 1493, 1524),
    },
    {
      id: "watch-cli",
      label: "rvw comment watchがRFC 7464フレームをストリームする",
      description:
        "ready、comment-posted、stoppedの各フレームをポーリングループから順番に標準出力へ出す。",
      kind: "CLI通信",
      anchor: source("src/cli/main.ts", 1122, 1180),
    },
    {
      id: "watch-driver",
      label: "外部の監視ドライバーがCLIプロセスを監督し再接続する",
      description:
        "RVW本体がAgentを起動するのではなく、外部タスクが子プロセスと再接続方針を所有する。",
      kind: "Agent通信",
      anchor: source("skills/rvw-watch-comments/scripts/watch-driver.mjs", 318, 461),
    },
    {
      id: "task-state",
      label: "タスク固有のSQLiteがカーソルとキューを原子的に進める",
      description:
        "イベント追加とカーソル更新を一つのトランザクションにし、重複、削除済み、自己イベントを明示的に扱う。",
      kind: "タスク状態",
      anchor: source("skills/rvw-watch-comments/scripts/watch-state.mjs", 348, 420),
    },
    {
      id: "capacity-gate",
      label: "予約済みワーカー容量が自動受付応答の配送を制御する",
      description: "処理中件数と最大処理中件数から、今回確保できるバッチだけを選ぶ。",
      kind: "スケジューラー",
      anchor: source("skills/rvw-watch-comments/scripts/watch-driver.mjs", 250, 260),
    },
    {
      id: "ack-post",
      label: "即時の受付応答も通常の返信である",
      description: "処理中表示も通常の投稿であり、後で同じ投稿を最終結果へ完全置換する。",
      kind: "レビューレコード",
      anchor: source("skills/rvw-watch-comments/SKILL.md"),
    },
    {
      id: "fresh-worker",
      label: "新しいsubagentが受付済みの一つのleaseを調査する",
      description:
        "親タスクは受付と最終投稿の所有権を保ち、調査・実装はleaseごとに新しいワーカーへ渡す。",
      kind: "外部Agentタスク",
      anchor: source("skills/rvw-watch-comments/SKILL.md"),
    },
    {
      id: "final-edit",
      label: "最終結果が受付応答の投稿を置き換える",
      description: "新しい完了返信を増やさず、バッチが所有する状態投稿を編集する。",
      kind: "レビューレコード",
      anchor: source("skills/rvw-watch-comments/SKILL.md"),
    },
  ],
  edges: [
    {
      id: "watch-01",
      from: "human-comment",
      to: "application-write",
      label: "通常のレビュー書き込みを送る",
      directed: true,
    },
    {
      id: "watch-02",
      from: "application-write",
      to: "sqlite-comment",
      label: "保存前に検証する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 1327, 1367)],
    },
    {
      id: "watch-03",
      from: "sqlite-comment",
      to: "ordered-event-log",
      label: "同じトランザクションでイベントを追記する",
      directed: true,
      anchors: [source("src/infrastructure/db/database.ts", 1154, 1162)],
    },
    {
      id: "watch-04",
      from: "ordered-event-log",
      to: "watch-application",
      label: "永続カーソルより後を読み取る",
      directed: true,
      anchors: [source("src/infrastructure/db/database.ts", 551, 569)],
    },
    {
      id: "watch-05",
      from: "watch-application",
      to: "watch-cli",
      label: "カーソルと有限件のイベントを返す",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 1493, 1524)],
    },
    {
      id: "watch-06",
      from: "watch-cli",
      to: "watch-driver",
      label: "フレーム化したトリガーを標準出力へ送る",
      directed: true,
      anchors: [source("src/cli/main.ts", 1150, 1176)],
    },
    {
      id: "watch-07",
      from: "watch-driver",
      to: "task-state",
      label: "配送前に各フレームを取り込む",
      directed: true,
      anchors: [source("skills/rvw-watch-comments/scripts/watch-driver.mjs", 277, 307)],
    },
    {
      id: "watch-08",
      from: "task-state",
      to: "capacity-gate",
      label: "保留中の作業と現在のleaseを公開する",
      directed: true,
    },
    {
      id: "watch-09",
      from: "capacity-gate",
      to: "ack-post",
      label: "受付応答の前に容量を確保する",
      directed: true,
      anchors: [source("skills/rvw-watch-comments/scripts/watch-driver.mjs", 250, 260)],
    },
    {
      id: "watch-10",
      from: "ack-post",
      to: "fresh-worker",
      label: "受付済みleaseを配送可能にする",
      directed: true,
    },
    {
      id: "watch-11",
      from: "fresh-worker",
      to: "final-edit",
      label: "本文、正確な参照、push状態を返す",
      directed: true,
    },
    {
      id: "watch-12",
      from: "final-edit",
      to: "ordered-event-log",
      label: "通常の返信もイベントになるが自己イベントとして抑止する",
      directed: true,
      anchors: [source("src/infrastructure/db/database.ts", 1449, 1481)],
    },
    {
      id: "watch-13",
      from: "task-state",
      to: "watch-driver",
      label: "再接続で使うカーソルを供給する",
      directed: true,
      anchors: [source("skills/rvw-watch-comments/scripts/watch-driver.mjs", 318, 323)],
    },
  ],
};

const commentWatchUpdate: Structure = {
  ...commentWatchStructure,
  title: "コメント監視フロー · current value更新の再現",
  nodes: [
    ...commentWatchStructure.nodes,
    {
      id: "notification-scan",
      label: "ViewerがAgentによる投稿編集をブラウザー通知のために走査する",
      description:
        "新しく追加された利用側は共有変更シーケンスを監視するが、監視イベントの順序は変えない。",
      kind: "Viewerの副作用",
      anchor: source("src/web/agent-notifications.ts"),
    },
  ],
  edges: [
    ...commentWatchStructure.edges,
    {
      id: "watch-update-01",
      from: "final-edit",
      to: "notification-scan",
      label: "共有変更シーケンスのポーリング後に可視化される",
      directed: true,
      anchors: [source("src/web/agent-notifications.ts")],
    },
  ],
};

const walkthroughPublishStructure: Structure = {
  id: "rvw-walkthrough-publish-flow",
  title: "Walkthrough公開フロー",
  scope:
    "Producerが明示したWalkthroughをSkillから公開し、正確なcommit上で検証・保存して、人間がViewerで任意のsourceへ降りるまで。",
  initialFocus: "walkthrough-skill",
  nodes: [
    {
      id: "walkthrough-skill",
      label: "rvw-walkthrough Skillが主題と読解経路を定める",
      description:
        "明示された目的を優先し、未指定部分だけリポジトリ上の事実と執筆時の既定値で補うProducer境界。",
      kind: "Skill",
      anchor: source("skills/rvw-walkthrough/SKILL.md", 1, 45),
    },
    {
      id: "publish-json",
      label: "CLI入力が一つのsource OID、本文、参照、図のbindingを宣言する",
      description: "Viewer状態やナビゲーション命令を含まない、完全な公開値。",
      kind: "契約",
      anchor: source("src/application/agent-command-schemas.ts", 189, 216),
    },
    {
      id: "publish-cli",
      label: "rvw walkthrough publishが受動的なCLI境界を越える",
      description: "JSONを解析してApplication Serviceへ渡し、ブラウザーは開かない。",
      kind: "CLI通信",
      anchor: source("src/cli/main.ts", 1032, 1055),
    },
    {
      id: "content-validation",
      label: "Applicationがsource anchor付きclaimを確認可能か検証する",
      description:
        "Commit、文書範囲、参照の到達可能性、Mermaid bindingを検証するが、説明の意味的な正しさは検証しない。",
      kind: "アプリケーション",
      anchor: source("src/application/rvw-service.ts", 1722, 1789),
    },
    {
      id: "retained-commit",
      label: "不変のGit refが正確なfallback snapshotを保持する",
      description: "DB書き込みより先にsource commit objectを保持し、失敗時は補償する。",
      kind: "Git基盤",
      anchor: source("src/application/rvw-service.ts", 1792, 1819),
    },
    {
      id: "current-walkthrough",
      label: "SQLiteがstable IDの下に現在のWalkthrough値を一つ保存する",
      description: "独自の改訂履歴を作らず、参照集合と同じトランザクションで保存する。",
      kind: "永続化",
      anchor: source("src/infrastructure/db/database.ts", 1019, 1047),
    },
    {
      id: "change-sequence",
      label: "共有変更シーケンスが開いているViewer queryを無効化する",
      description: "CLI更新をポーリングで検出し、同じ文書タブへ現在値を再bindingする。",
      kind: "ブラウザー同期",
      anchor: source("src/web/app/PullRequestReviewScreen.tsx"),
    },
    {
      id: "walkthrough-document",
      label: "Walkthroughは独立した文書タブとして残る",
      description: "開いただけではcodeを自動で開かず、人間の読解経路として残る。",
      kind: "読解surface",
      anchor: source("src/web/components/WalkthroughViewer.tsx", 562, 687),
    },
    {
      id: "human-reference-action",
      label: "人間が本文中の参照またはbinding済みMermaid Nodeを一つ選ぶ",
      description: "Agentではなく人間が、いつどのclaimをsourceと照合するか決める。",
      kind: "ユーザー操作",
      anchor: source("src/web/components/CodeReferenceLink.tsx", 33, 75),
    },
    {
      id: "latest-resolution",
      label: "参照をanchor commitから最新PR headへ直接解決する",
      description: "安全に追跡できない場合だけ、保証されたanchor sourceへfallbackする。",
      kind: "アプリケーション",
      anchor: source("src/application/rvw-service.ts", 1537, 1708),
    },
    {
      id: "exact-code",
      label: "正確にcommitされたcodeを文書workspaceで開く",
      description: "説明はclaimの索引であり、最終的な事実の正本はGit object上のsource。",
      kind: "事実の正本",
      anchor: source("src/web/components/DocumentViewer.tsx", 718, 777),
    },
  ],
  edges: [
    {
      id: "publish-01",
      from: "walkthrough-skill",
      to: "publish-json",
      label: "依頼された主題を読解経路として執筆する",
      directed: true,
      anchors: [source("skills/rvw-walkthrough/SKILL.md", 30, 45)],
    },
    {
      id: "publish-02",
      from: "publish-json",
      to: "publish-cli",
      label: "EOFで終端した一つのJSON objectとして送る",
      directed: true,
      anchors: [source("skills/rvw-walkthrough/SKILL.md", 56, 91)],
    },
    {
      id: "publish-03",
      from: "publish-cli",
      to: "content-validation",
      label: "共有Application Serviceを呼び出す",
      directed: true,
      anchors: [source("src/cli/main.ts", 1039, 1053)],
    },
    {
      id: "publish-04",
      from: "content-validation",
      to: "retained-commit",
      label: "確認可能で正確な座標だけを受理する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 1722, 1789)],
    },
    {
      id: "publish-05",
      from: "retained-commit",
      to: "current-walkthrough",
      label: "保持済みsourceでDB書き込みを保護する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 1821, 1829)],
    },
    {
      id: "publish-06",
      from: "current-walkthrough",
      to: "change-sequence",
      label: "現在値のcommit後に増加する",
      directed: true,
      anchors: [source("src/infrastructure/db/database.ts", 1019, 1042)],
    },
    {
      id: "publish-07",
      from: "change-sequence",
      to: "walkthrough-document",
      label: "開いている同一identityを更新する",
      directed: true,
      anchors: [source("src/web/app/PullRequestReviewScreen.tsx")],
    },
    {
      id: "publish-08",
      from: "walkthrough-document",
      to: "human-reference-action",
      label: "自動で移動せずclaimを提示する",
      directed: true,
    },
    {
      id: "publish-09",
      from: "human-reference-action",
      to: "latest-resolution",
      label: "人間の操作後に参照を一つだけ要求する",
      directed: true,
      anchors: [source("src/web/components/WalkthroughViewer.tsx", 658, 676)],
    },
    {
      id: "publish-10",
      from: "latest-resolution",
      to: "exact-code",
      label: "確実なら最新を、そうでなければ正確なanchorを開く",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 1537, 1708)],
    },
    {
      id: "publish-11",
      from: "exact-code",
      to: "walkthrough-document",
      label: "読解を続けられるよう説明タブを維持する",
      directed: false,
    },
    {
      id: "publish-12",
      from: "current-walkthrough",
      to: "content-validation",
      label: "同一IDの上書き更新も完全な検証を再通過する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 1832, 1840)],
    },
  ],
};

const documentNavigationStructure: Structure = {
  id: "rvw-document-two-pane-navigation",
  title: "文書と2ペインのナビゲーション",
  scope:
    "WalkthroughまたはStructure上の明示的なsource affordanceから、既存の左右ペインの文書契約を通って正確なsourceを開き、元の読解surfaceへ戻るまで。",
  initialFocus: "source-affordance",
  nodes: [
    {
      id: "source-affordance",
      label: "読解surfaceの選択と分離された明示的なsource affordance",
      description: "Nodeや説明そのものを選ぶ操作と、codeへ降りる操作を分離する、人間との操作境界。",
      kind: "操作",
      anchor: source("src/web/components/CodeReferenceLink.tsx", 33, 75),
    },
    {
      id: "modifier-contract",
      label: "通常openは左、Cmd / Ctrl + openは右を対象にする",
      description: "操作元や現在focus中のペインに依存しないRVW共通のナビゲーション契約。",
      kind: "ナビゲーション規則",
      anchor: source("docs/implementation-spec.md", 294, 300),
    },
    {
      id: "left-pane",
      label: "左の文書ペイン",
      description: "通常openの決定的な対象。既存タブは閉じず、対象文書をactiveにする。",
      kind: "workspaceペイン",
    },
    {
      id: "right-pane",
      label: "必要なときに作られる右の文書ペイン",
      description: "修飾キー付きopenの決定的な対象。説明とsourceを横並びで読めるようにする。",
      kind: "workspaceペイン",
    },
    {
      id: "workspace-assignment",
      label: "文書workspaceがペインごとに一つのidentityを割り当て、開いたタブを保つ",
      description:
        "同一identityはペインごとに一つまで。追加、再active化、左右移動をブラウザーセッション状態として扱う。",
      kind: "workspace状態",
      anchor: source("src/web/document-workspace.ts", 152, 205),
    },
    {
      id: "reading-history",
      label: "読解履歴は全体のreview scopeではなく移動先の文書と位置を記録する",
      description:
        "戻る / 進むでfocus中の文書と位置を復元し、反対ペインやcommit範囲は巻き戻さない。",
      kind: "ブラウザー状態",
      anchor: source("src/web/reading-history.ts", 8, 29),
    },
    {
      id: "exact-document-fetch",
      label: "Document APIがcommit済みGit objectからsource OIDとpathを読む",
      description: "worktreeやindexではなく、選択された正確なsnapshotで文書が利用可能かを返す。",
      kind: "読み取り境界",
      anchor: source("src/server/app.ts", 251, 286),
    },
    {
      id: "document-viewer",
      label: "DocumentViewerが正確な全文sourceまたは変更されていない全体diff lensを描画する",
      description:
        "source navigation固有のreview scopeを作らず、必要なペインだけ正確なsource全文表示へfallbackする。",
      kind: "読解surface",
      anchor: source("src/web/components/DocumentViewer.tsx", 718, 890),
    },
    {
      id: "line-locator",
      label: "対象文書の描画後に両端を含むsource範囲を中央へ置く",
      description: "行anchorは対象ペインだけに適用され、選択範囲全体を強調する。",
      kind: "ナビゲーション位置",
      anchor: source("src/web/components/DocumentViewer.tsx", 851, 878),
    },
    {
      id: "global-review-scope",
      label: "Commit範囲、全文 / Diff、上下 / 左右表示は全体設定のまま変えない",
      description:
        "Source確認は文書ナビゲーションであり、リポジトリの読解lensを別の状態へ書き換えない。",
      kind: "不変条件",
      anchor: source("docs/implementation-spec.md", 299, 313),
    },
    {
      id: "origin-tab",
      label: "起点のWalkthroughまたはStructureタブが作業集合に残る",
      description: "Source確認後に元タブをactiveにすれば、同じ読解surfaceで探索を継続できる。",
      kind: "空間認識",
      anchor: source("src/web/document-workspace.ts", 152, 172),
    },
  ],
  edges: [
    {
      id: "navigation-01",
      from: "source-affordance",
      to: "modifier-contract",
      label: "明示的なopen時だけ修飾キー状態を取得する",
      directed: true,
      anchors: [source("src/web/components/CodeReferenceLink.tsx", 48, 65)],
    },
    {
      id: "navigation-02",
      from: "modifier-contract",
      to: "left-pane",
      label: "通常openを振り分ける",
      directed: true,
      anchors: [source("docs/implementation-spec.md", 294, 300)],
    },
    {
      id: "navigation-03",
      from: "modifier-contract",
      to: "right-pane",
      label: "修飾キー付きopenを振り分ける",
      directed: true,
      anchors: [source("docs/implementation-spec.md", 294, 300)],
    },
    {
      id: "navigation-04",
      from: "left-pane",
      to: "workspace-assignment",
      label: "対象文書を受け取る",
      directed: true,
    },
    {
      id: "navigation-05",
      from: "right-pane",
      to: "workspace-assignment",
      label: "同じ対象identityを独立して受け取る",
      directed: true,
    },
    {
      id: "navigation-06",
      from: "workspace-assignment",
      to: "reading-history",
      label: "人間のナビゲーション操作を記録する",
      directed: true,
      anchors: [source("src/web/reading-history.ts", 8, 29)],
    },
    {
      id: "navigation-07",
      from: "workspace-assignment",
      to: "exact-document-fetch",
      label: "source OIDとpathの文書をactiveにする",
      directed: true,
    },
    {
      id: "navigation-08",
      from: "exact-document-fetch",
      to: "document-viewer",
      label: "commit済み本文と利用可否を供給する",
      directed: true,
      anchors: [source("src/web/components/DocumentViewer.tsx", 718, 777)],
    },
    {
      id: "navigation-09",
      from: "document-viewer",
      to: "line-locator",
      label: "描画後に指定範囲を適用する",
      directed: true,
      anchors: [source("src/web/components/DocumentViewer.tsx", 851, 878)],
    },
    {
      id: "navigation-10",
      from: "global-review-scope",
      to: "document-viewer",
      label: "現在の読解lensを引き続き供給する",
      directed: true,
    },
    {
      id: "navigation-11",
      from: "workspace-assignment",
      to: "origin-tab",
      label: "操作元を閉じない",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 152, 172)],
    },
    {
      id: "navigation-12",
      from: "origin-tab",
      to: "source-affordance",
      label: "文脈を組み直さず次の疑問へ進める",
      directed: true,
    },
    {
      id: "navigation-13",
      from: "reading-history",
      to: "origin-tab",
      label: "以前の読解先を復元できる",
      directed: true,
    },
  ],
};

const rvwServiceCodeStructure: Structure = {
  id: "rvw-service-code-neighborhood",
  title: "RvwServiceのコード依存関係",
  scope:
    "src/application/rvw-service.tsのRvwService classを中心に、constructor injection、内部で使うdomain helper、実装を呼び出すadapterをコード上の依存関係として示す。処理順は表さない。",
  initialFocus: "rvw-service-class",
  nodes: [
    {
      id: "rvw-service-class",
      label: "RvwService class",
      description:
        "RVWのapplication use caseをまとめるclass。DB、Git、GitHubをconstructorから受け取り、HTTPやAgent transportには依存しない。",
      kind: "class",
      notation: "class",
      anchor: source("src/application/rvw-service.ts", 493, 510),
    },
    {
      id: "runtime-composition",
      label: "createRuntime",
      description:
        "具象のRvwDatabase、GitClient、GitHubClientを生成してRvwServiceへ注入するcomposition root。",
      kind: "composition root",
      notation: "component",
      anchor: source("src/application/runtime.ts", 14, 25),
    },
    {
      id: "rvw-database-class",
      label: "RvwDatabase class",
      description:
        "SQLiteの永続化とtransactionを所有する具象class。RvwServiceのpublic readonly dependency。",
      kind: "class",
      notation: "database",
      anchor: source("src/infrastructure/db/database.ts", 354, 399),
    },
    {
      id: "git-client-class",
      label: "GitClient class",
      description:
        "commit、tree、diff、source blob、検索など、Git objectを事実の正本として読む具象class。",
      kind: "class",
      notation: "class",
      anchor: source("src/infrastructure/git/git-client.ts", 190, 223),
    },
    {
      id: "github-port",
      label: "GitHubPort interface",
      description:
        "RvwServiceが必要とするGitHub操作のport。具象GitHubClientではなくinterfaceへ依存する。",
      kind: "interface",
      notation: "interface",
      anchor: source("src/infrastructure/github/github-client.ts", 12, 21),
    },
    {
      id: "github-client-class",
      label: "GitHubClient class",
      description: "gh CLIを使ってGitHubPortを実装するinfrastructure adapter。",
      kind: "class",
      notation: "class",
      anchor: source("src/infrastructure/github/github-client.ts", 57, 76),
    },
    {
      id: "domain-models",
      label: "domain/models.tsの共有型",
      description:
        "PullRequest、Comment、Document、Walkthroughなど、RvwServiceの入出力を表すdomain value。",
      kind: "module",
      notation: "component",
      anchor: source("src/domain/models.ts"),
    },
    {
      id: "line-mapping-helper",
      label: "line-mapping helper",
      description:
        "commit間でコメント位置を追跡し、変更可能なdocumentへのplacementを計算するdomain helper。",
      kind: "module",
      notation: "component",
      anchor: source("src/domain/line-mapping.ts"),
    },
    {
      id: "pr-markdown-helper",
      label: "Pull Request Markdown helper",
      description:
        "Pull Request.mdの生成、document hash、選択行textの抽出を提供するdomain helper。",
      kind: "module",
      notation: "component",
      anchor: source("src/domain/pr-markdown.ts"),
    },
    {
      id: "source-excerpt-helper",
      label: "source excerpt helper",
      description: "正確なsource textから、行範囲付きの検査可能な抜粋を生成する。",
      kind: "module",
      notation: "component",
      anchor: source("src/domain/source-excerpt.ts"),
    },
    {
      id: "service-policy-constants",
      label: "入力上限とOID policy",
      description:
        "body、reference、検索、Walkthroughなどの上限とGit object ID形式を共有定数として供給する。",
      kind: "policy module",
      notation: "component",
      anchor: source("src/shared/constants.ts"),
    },
    {
      id: "rvw-error-model",
      label: "RvwError error model",
      description:
        "application、infrastructure、transportをまたいでcode、status、suggestionを保持する明示的なerror型。",
      kind: "class",
      notation: "class",
      anchor: source("src/shared/errors.ts"),
    },
    {
      id: "http-app-adapter",
      label: "Hono createApp adapter",
      description:
        "HTTP requestを検証してRvwServiceのuse caseを呼ぶinbound adapter。ServiceはHonoをimportしない。",
      kind: "adapter",
      notation: "external",
      anchor: source("src/server/app.ts", 118, 135),
    },
    {
      id: "agent-socket-adapter",
      label: "dispatchAgentSocketRequest",
      description:
        "Agent operationをschema検証し、対応するRvwService methodへdispatchするinbound adapter。",
      kind: "adapter",
      notation: "external",
      anchor: source("src/server/agent-socket.ts", 290, 317),
    },
    {
      id: "cli-runtime-consumer",
      label: "CLI main",
      description:
        "runtimeを生成または再利用し、直接RvwServiceを組み立てずにCLI commandを提供する外側のconsumer。",
      kind: "consumer",
      notation: "external",
      anchor: source("src/cli/main.ts", 1, 46),
    },
  ],
  edges: [
    {
      id: "service-code-01",
      from: "runtime-composition",
      to: "rvw-service-class",
      label: "具象dependencyを注入して生成する",
      directed: true,
      anchors: [source("src/application/runtime.ts", 21, 25)],
    },
    {
      id: "service-code-02",
      from: "rvw-service-class",
      to: "rvw-database-class",
      label: "constructorで永続化dependencyを要求する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 493, 498)],
    },
    {
      id: "service-code-03",
      from: "rvw-service-class",
      to: "git-client-class",
      label: "constructorでGit object accessを要求する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 493, 498)],
    },
    {
      id: "service-code-04",
      from: "rvw-service-class",
      to: "github-port",
      label: "constructorでportだけを要求する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 493, 498)],
    },
    {
      id: "service-code-05",
      from: "github-client-class",
      to: "github-port",
      label: "interfaceを実装する",
      directed: true,
      anchors: [source("src/infrastructure/github/github-client.ts", 12, 21)],
    },
    {
      id: "service-code-06",
      from: "runtime-composition",
      to: "rvw-database-class",
      label: "既定の具象instanceを生成する",
      directed: true,
      anchors: [source("src/application/runtime.ts", 20, 25)],
    },
    {
      id: "service-code-07",
      from: "runtime-composition",
      to: "git-client-class",
      label: "既定の具象instanceを生成する",
      directed: true,
      anchors: [source("src/application/runtime.ts", 20, 25)],
    },
    {
      id: "service-code-08",
      from: "runtime-composition",
      to: "github-client-class",
      label: "既定のport実装を生成する",
      directed: true,
      anchors: [source("src/application/runtime.ts", 20, 25)],
    },
    {
      id: "service-code-09",
      from: "rvw-service-class",
      to: "domain-models",
      label: "use caseの入出力型としてimportする",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 4, 32)],
    },
    {
      id: "service-code-10",
      from: "rvw-service-class",
      to: "line-mapping-helper",
      label: "comment placement計算を委譲する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 38, 40)],
    },
    {
      id: "service-code-11",
      from: "rvw-service-class",
      to: "pr-markdown-helper",
      label: "PR documentの生成とhashを委譲する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 41, 41)],
    },
    {
      id: "service-code-12",
      from: "rvw-service-class",
      to: "source-excerpt-helper",
      label: "正確なsource抜粋の生成を委譲する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 42, 42)],
    },
    {
      id: "service-code-13",
      from: "rvw-service-class",
      to: "service-policy-constants",
      label: "validation上限を共有する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 43, 63)],
    },
    {
      id: "service-code-14",
      from: "rvw-service-class",
      to: "rvw-error-model",
      label: "失敗を明示的なerrorとして表す",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 65, 65)],
    },
    {
      id: "service-code-15",
      from: "http-app-adapter",
      to: "rvw-service-class",
      label: "HTTP use caseを呼び出す",
      directed: true,
      anchors: [source("src/server/app.ts", 7, 7), source("src/server/app.ts", 118, 119)],
    },
    {
      id: "service-code-16",
      from: "agent-socket-adapter",
      to: "rvw-service-class",
      label: "Agent operationをmethodへdispatchする",
      directed: true,
      anchors: [source("src/server/agent-socket.ts", 290, 317)],
    },
    {
      id: "service-code-17",
      from: "cli-runtime-consumer",
      to: "runtime-composition",
      label: "application runtimeを利用する",
      directed: true,
      anchors: [source("src/cli/main.ts", 9, 10)],
    },
    {
      id: "service-code-18",
      from: "cli-runtime-consumer",
      to: "rvw-service-class",
      label: "Runtime.service経由でuse caseを呼ぶ",
      directed: true,
      anchors: [source("src/cli/main.ts", 1047, 1053)],
    },
  ],
};

const documentWorkspaceCodeStructure: Structure = {
  id: "document-workspace-code-neighborhood",
  title: "document-workspace moduleの関連コード",
  scope:
    "src/web/document-workspace.tsのActiveDocumentとDocumentWorkspaceStateを中心に、identity、状態更新、表示、履歴、draft移動を担うコードの依存関係を示す。画面操作の順序は表さない。",
  initialFocus: "active-document-union",
  nodes: [
    {
      id: "active-document-union",
      label: "ActiveDocument union",
      description:
        "PR本文、Walkthrough、Structure、repository fileを一つのdocument identity集合として表すdiscriminated union。",
      kind: "type",
      notation: "interface",
      anchor: source("src/web/document-workspace.ts", 17, 29),
    },
    {
      id: "reference-document-context",
      label: "ReferenceDocumentContext",
      description:
        "Walkthrough参照のlatest / source-fallback結果とfingerprintをrepository-file documentへ付加する型。",
      kind: "interface",
      notation: "interface",
      anchor: source("src/web/document-workspace.ts", 5, 15),
    },
    {
      id: "workspace-state-type",
      label: "DocumentWorkspaceState",
      description:
        "左右ペインの文書集合、active document、focus中のペイン、navigation revisionを保持する状態型。",
      kind: "interface",
      notation: "interface",
      anchor: source("src/web/document-workspace.ts", 31, 43),
    },
    {
      id: "document-tab-identity",
      label: "documentTabKey / paneTabKey",
      description:
        "document kindとstable IDまたはpathから、workspace内およびペイン内のidentity keyを導出する。",
      kind: "function group",
      notation: "component",
      anchor: source("src/web/document-workspace.ts", 47, 68),
    },
    {
      id: "workspace-mutations",
      label: "assign / move / remove document",
      description:
        "DocumentWorkspaceStateをimmutableに更新し、重複identity、active tab、空ペインの正規化を扱う。",
      kind: "function group",
      notation: "component",
      anchor: source("src/web/document-workspace.ts", 145, 256),
    },
    {
      id: "pane-transition-detector",
      label: "documentPaneTransitions",
      description:
        "前後のworkspace stateを比較し、同じdocumentが左右ペイン間を移動した事実を抽出する。",
      kind: "function",
      notation: "component",
      anchor: source("src/web/document-workspace.ts", 120, 135),
    },
    {
      id: "current-commit-projection",
      label: "currentCommitDocument",
      description:
        "global commit rangeへ戻すとき、exact-source固有情報を落として現在commit用のdocumentへ射影する。",
      kind: "function",
      notation: "component",
      anchor: source("src/web/document-workspace.ts", 258, 263),
    },
    {
      id: "workspace-react-hook",
      label: "useDocumentWorkspace",
      description:
        "純粋なworkspace関数をReact stateとrefへ接続し、open、activate、close、move APIを提供するhook。",
      kind: "hook",
      notation: "component",
      anchor: source("src/web/use-document-workspace.ts", 19, 123),
    },
    {
      id: "review-screen-consumer",
      label: "PullRequestReviewScreen",
      description:
        "workspace hookを所有し、draft移動、履歴、source navigation、左右ペインの描画を統合するconsumer。",
      kind: "component",
      notation: "external",
      anchor: source("src/web/app/PullRequestReviewScreen.tsx", 592, 598),
    },
    {
      id: "document-tabs-component",
      label: "DocumentTabs",
      description:
        "ActiveDocument[]をtab UIとして描画し、activate、close、drag / drop、左右移動のintentを外へ返す。",
      kind: "component",
      notation: "component",
      anchor: source("src/web/components/DocumentTabs.tsx", 43, 80),
    },
    {
      id: "tab-presentation-module",
      label: "document-tab-presentation",
      description:
        "同名fileや同じpathの別identityを区別できるdisplay labelとaccessible labelを導出する。",
      kind: "module",
      notation: "component",
      anchor: source("src/web/document-tab-presentation.ts", 30, 65),
    },
    {
      id: "reading-history-module",
      label: "reading-history",
      description: "ActiveDocumentとlocatorをbrowser historyへ保存し、外部入力から安全に復元する。",
      kind: "module",
      notation: "component",
      anchor: source("src/web/reading-history.ts", 8, 45),
    },
    {
      id: "comment-draft-store-module",
      label: "comment-draft-store",
      description:
        "document identityとpaneをdraft scopeに含め、workspace transitionに合わせてdraftを衝突検査付きで移動する。",
      kind: "module",
      notation: "component",
      anchor: source("src/web/comment-draft-store.ts", 48, 90),
    },
    {
      id: "viewer-state-derivation",
      label: "deriveDocumentViewerState",
      description:
        "ActiveDocumentとglobal review scopeから、DocumentViewerへ渡す表示mode、fallback、stalenessを導出する。",
      kind: "function",
      notation: "component",
      anchor: source("src/web/document-viewer-state.ts", 40, 73),
    },
  ],
  edges: [
    {
      id: "workspace-code-01",
      from: "active-document-union",
      to: "reference-document-context",
      label: "repository-file variantが参照文脈を保持する",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 17, 29)],
    },
    {
      id: "workspace-code-02",
      from: "workspace-state-type",
      to: "active-document-union",
      label: "文書集合とactive値のelement型にする",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 31, 36)],
    },
    {
      id: "workspace-code-03",
      from: "document-tab-identity",
      to: "active-document-union",
      label: "kindとstable identityを読み取る",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 47, 68)],
    },
    {
      id: "workspace-code-04",
      from: "workspace-mutations",
      to: "workspace-state-type",
      label: "immutableな次状態を返す",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 145, 256)],
    },
    {
      id: "workspace-code-05",
      from: "workspace-mutations",
      to: "document-tab-identity",
      label: "重複と対象tabの照合に使う",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 155, 205)],
    },
    {
      id: "workspace-code-06",
      from: "pane-transition-detector",
      to: "workspace-state-type",
      label: "前後stateを比較する",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 120, 135)],
    },
    {
      id: "workspace-code-07",
      from: "pane-transition-detector",
      to: "document-tab-identity",
      label: "同一documentの移動を識別する",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 120, 135)],
    },
    {
      id: "workspace-code-08",
      from: "current-commit-projection",
      to: "active-document-union",
      label: "別のdocument variantへ射影する",
      directed: true,
      anchors: [source("src/web/document-workspace.ts", 258, 263)],
    },
    {
      id: "workspace-code-09",
      from: "workspace-react-hook",
      to: "workspace-mutations",
      label: "open / close / moveを委譲する",
      directed: true,
      anchors: [source("src/web/use-document-workspace.ts", 52, 108)],
    },
    {
      id: "workspace-code-10",
      from: "workspace-react-hook",
      to: "workspace-state-type",
      label: "React stateとrefで所有する",
      directed: true,
      anchors: [source("src/web/use-document-workspace.ts", 19, 33)],
    },
    {
      id: "workspace-code-11",
      from: "review-screen-consumer",
      to: "workspace-react-hook",
      label: "画面のdocument workspaceとして利用する",
      directed: true,
      anchors: [source("src/web/app/PullRequestReviewScreen.tsx", 592, 598)],
    },
    {
      id: "workspace-code-12",
      from: "document-tabs-component",
      to: "active-document-union",
      label: "tabの入力とevent payloadに使う",
      directed: true,
      anchors: [source("src/web/components/DocumentTabs.tsx", 43, 80)],
    },
    {
      id: "workspace-code-13",
      from: "document-tabs-component",
      to: "tab-presentation-module",
      label: "各tabの表示名を委譲する",
      directed: true,
      anchors: [source("src/web/components/DocumentTabs.tsx", 163, 169)],
    },
    {
      id: "workspace-code-14",
      from: "tab-presentation-module",
      to: "document-tab-identity",
      label: "identity、path、label helperを共有する",
      directed: true,
      anchors: [source("src/web/document-tab-presentation.ts", 1, 6)],
    },
    {
      id: "workspace-code-15",
      from: "reading-history-module",
      to: "active-document-union",
      label: "履歴entryとしてserialize / parseする",
      directed: true,
      anchors: [source("src/web/reading-history.ts", 13, 45)],
    },
    {
      id: "workspace-code-16",
      from: "comment-draft-store-module",
      to: "pane-transition-detector",
      label: "document移動からdraft移動を導出する",
      directed: true,
      anchors: [source("src/web/comment-draft-store.ts", 180, 213)],
    },
    {
      id: "workspace-code-17",
      from: "comment-draft-store-module",
      to: "document-tab-identity",
      label: "draft scopeへdocument identityを埋め込む",
      directed: true,
      anchors: [source("src/web/comment-draft-store.ts", 48, 90)],
    },
    {
      id: "workspace-code-18",
      from: "viewer-state-derivation",
      to: "active-document-union",
      label: "document kindとcomparison policyを判定する",
      directed: true,
      anchors: [source("src/web/document-viewer-state.ts", 40, 77)],
    },
    {
      id: "workspace-code-19",
      from: "review-screen-consumer",
      to: "reading-history-module",
      label: "browser navigationとの同期に使う",
      directed: true,
      anchors: [source("src/web/app/PullRequestReviewScreen.tsx", 100, 106)],
    },
    {
      id: "workspace-code-20",
      from: "review-screen-consumer",
      to: "comment-draft-store-module",
      label: "workspace変更前にdraft移動を調整する",
      directed: true,
      anchors: [source("src/web/app/PullRequestReviewScreen.tsx", 957, 986)],
    },
    {
      id: "workspace-code-21",
      from: "review-screen-consumer",
      to: "viewer-state-derivation",
      label: "各ペインのviewer stateを導出する",
      directed: true,
      anchors: [source("src/web/app/PullRequestReviewScreen.tsx", 2167, 2168)],
    },
  ],
};

const gitClientCodeStructure: Structure = {
  id: "git-client-code-neighborhood",
  title: "GitClientの境界と依存関係",
  scope:
    "src/infrastructure/git/git-client.tsのGitClient classを中心に、process境界、parser、戻り値のdomain型、exact source読取、保持ref、利用側コードの関係を示す。Git commandの実行順は表さない。",
  initialFocus: "git-client-core",
  nodes: [
    {
      id: "git-client-core",
      label: "GitClient class",
      description:
        "native gitを通じてrepository context、commit、tree、diff、source、検索を提供するinfrastructure class。",
      kind: "class",
      notation: "class",
      anchor: source("src/infrastructure/git/git-client.ts", 190, 223),
    },
    {
      id: "process-runner-module",
      label: "runProcess / runText",
      description:
        "shellを使わず子processを起動し、timeout、出力上限、終了code、error変換を一箇所で扱う。",
      kind: "process adapter",
      notation: "component",
      anchor: source("src/infrastructure/process/run-process.ts", 28, 160),
    },
    {
      id: "native-git-process",
      label: "native git executable",
      description:
        "RVW coreの外にある実行対象。GitClientはlibrary bindingではなくargv付きprocessとして呼ぶ。",
      kind: "外部境界",
      notation: "external",
    },
    {
      id: "repository-context-type",
      label: "RepositoryContext",
      description:
        "worktree pathとgit common dirを組にし、複数worktreeでも同じrepositoryを識別する。",
      kind: "interface",
      notation: "interface",
      anchor: source("src/infrastructure/git/git-client.ts", 25, 28),
    },
    {
      id: "git-domain-models",
      label: "Git結果を受けるdomain model",
      description:
        "ChangedFile、CommitSummary、DocumentAvailability、SearchResult、TreeEntryをGit出力の戻り値として使う。",
      kind: "module",
      notation: "interface",
      anchor: source("src/domain/models.ts"),
    },
    {
      id: "git-policy-constants",
      label: "Git読取のsize / result上限",
      description:
        "Markdown asset、検索stdout、text documentの上限をprocess実行前後のpolicyとして供給する。",
      kind: "policy module",
      notation: "component",
      anchor: source("src/shared/constants.ts"),
    },
    {
      id: "git-error-model",
      label: "RvwError",
      description:
        "git未導入、process失敗、不正path、巨大file、binaryなどの境界失敗を明示的なcodeへ変換する。",
      kind: "class",
      notation: "class",
      anchor: source("src/shared/errors.ts"),
    },
    {
      id: "git-output-parsers",
      label: "ls-tree / name-status / log parser",
      description: "NUL区切りを含むnative git出力を、domain modelの配列へ変換する純粋関数群。",
      kind: "function group",
      notation: "component",
      anchor: source("src/infrastructure/git/git-client.ts", 84, 178),
    },
    {
      id: "exact-source-reader",
      label: "GitClient.readDocument",
      description:
        "source OIDとpathからblobを読み、missing、submodule、too-large、binary、textを区別して返す。",
      kind: "method",
      notation: "component",
      anchor: source("src/infrastructure/git/git-client.ts", 501, 574),
    },
    {
      id: "retained-ref-methods",
      label: "commit ref保持method群",
      description:
        "refs/rvw以下のstable refを作成、検証、削除し、exact commit objectを到達可能に保つ。",
      kind: "method group",
      notation: "component",
      anchor: source("src/infrastructure/git/git-client.ts", 367, 443),
    },
    {
      id: "git-search-method",
      label: "GitClient.search",
      description:
        "git grepの固定文字列検索をbounded stdoutで実行し、match位置とtruncationを返す。",
      kind: "method",
      notation: "component",
      anchor: source("src/infrastructure/git/git-client.ts", 604, 661),
    },
    {
      id: "service-git-consumer",
      label: "RvwService",
      description:
        "GitClientをconstructor dependencyとして受け取り、application use caseからGitの事実へアクセスする。",
      kind: "consumer class",
      notation: "class",
      anchor: source("src/application/rvw-service.ts", 493, 510),
    },
    {
      id: "runtime-git-composition",
      label: "createRuntime",
      description: "既定のGitClient instanceを生成し、RvwServiceへ渡すcomposition root。",
      kind: "composition root",
      notation: "component",
      anchor: source("src/application/runtime.ts", 14, 25),
    },
  ],
  edges: [
    {
      id: "git-code-01",
      from: "git-client-core",
      to: "process-runner-module",
      label: "すべてのgit起動を委譲する",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 21, 21)],
    },
    {
      id: "git-code-02",
      from: "process-runner-module",
      to: "native-git-process",
      label: "shellなしでargvを渡して起動する",
      directed: true,
      anchors: [source("src/infrastructure/process/run-process.ts", 28, 50)],
    },
    {
      id: "git-code-03",
      from: "git-client-core",
      to: "repository-context-type",
      label: "repository identityとして生成・返却する",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 202, 214)],
    },
    {
      id: "git-code-04",
      from: "git-client-core",
      to: "git-domain-models",
      label: "public methodの戻り値に使う",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 4, 12)],
    },
    {
      id: "git-code-05",
      from: "git-client-core",
      to: "git-policy-constants",
      label: "読取と検索の上限を適用する",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 13, 18)],
    },
    {
      id: "git-code-06",
      from: "git-client-core",
      to: "git-error-model",
      label: "境界失敗をRVW errorへ変換する",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 20, 20)],
    },
    {
      id: "git-code-07",
      from: "process-runner-module",
      to: "git-error-model",
      label: "timeoutとprocess失敗をcode化する",
      directed: true,
      anchors: [source("src/infrastructure/process/run-process.ts", 52, 65)],
    },
    {
      id: "git-code-08",
      from: "git-client-core",
      to: "git-output-parsers",
      label: "command outputのdecodeを委譲する",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 84, 178)],
    },
    {
      id: "git-code-09",
      from: "exact-source-reader",
      to: "git-output-parsers",
      label: "ls-tree結果から対象entryを選ぶ",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 501, 507)],
    },
    {
      id: "git-code-10",
      from: "git-client-core",
      to: "exact-source-reader",
      label: "exact source読取methodを所有する",
      directed: true,
    },
    {
      id: "git-code-11",
      from: "exact-source-reader",
      to: "git-policy-constants",
      label: "text byte上限を適用する",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 528, 541)],
    },
    {
      id: "git-code-12",
      from: "git-client-core",
      to: "retained-ref-methods",
      label: "exact commit保持methodを所有する",
      directed: true,
    },
    {
      id: "git-code-13",
      from: "retained-ref-methods",
      to: "process-runner-module",
      label: "update-ref / show-refを実行する",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 372, 390)],
    },
    {
      id: "git-code-14",
      from: "git-client-core",
      to: "git-search-method",
      label: "bounded repository検索methodを所有する",
      directed: true,
    },
    {
      id: "git-code-15",
      from: "git-search-method",
      to: "process-runner-module",
      label: "git grepをbounded processとして呼ぶ",
      directed: true,
      anchors: [source("src/infrastructure/git/git-client.ts", 604, 623)],
    },
    {
      id: "git-code-16",
      from: "service-git-consumer",
      to: "git-client-core",
      label: "constructor dependencyとして保持する",
      directed: true,
      anchors: [source("src/application/rvw-service.ts", 493, 498)],
    },
    {
      id: "git-code-17",
      from: "runtime-git-composition",
      to: "git-client-core",
      label: "既定instanceを生成する",
      directed: true,
      anchors: [source("src/application/runtime.ts", 20, 24)],
    },
    {
      id: "git-code-18",
      from: "runtime-git-composition",
      to: "service-git-consumer",
      label: "同じinstanceをServiceへ注入する",
      directed: true,
      anchors: [source("src/application/runtime.ts", 22, 25)],
    },
  ],
};

const railsReactFixtureRoot = "test/fixtures/structure-spike/rails-react-page";
const railsReactSource = (path: string): SourceAnchor => source(`${railsReactFixtureRoot}/${path}`);

const railsReactPageCodeStructure: Structure = {
  id: "rails-react-jobs-page-code-neighborhood",
  title: "Rails ViewとReact rootをまたぐ求人検索ページ",
  scope:
    "Spike専用の小さなRails / React source fixtureについて、Jobs index ViewとDOM mount contract、React entryを中央に置き、左へController・Service・Model・Policy・Serializer、右へpage componentと子componentのコード関係を示す。処理順を読むための図ではない。",
  initialFocus: "jobs-dom-mount-contract",
  nodes: [
    {
      id: "jobs-route",
      label: "GET /jobs route",
      description: "JobsController#indexをWeb requestの入口として公開するRails route。",
      kind: "route",
      notation: "external",
      anchor: railsReactSource("config/routes.rb"),
    },
    {
      id: "jobs-controller",
      label: "JobsController#index",
      description:
        "current_userとqueryをJobSearchServiceへ渡し、serializerの結果をView用の@page_payloadへassignする。",
      kind: "controller",
      notation: "class",
      anchor: railsReactSource("app/controllers/jobs_controller.rb"),
    },
    {
      id: "job-search-service",
      label: "JobSearchService",
      description:
        "認可済みscopeへ検索、companyのeager load、pagination、facet集計を組み合わせるuse case。",
      kind: "service",
      notation: "class",
      anchor: railsReactSource("app/services/job_search_service.rb"),
    },
    {
      id: "job-search-result",
      label: "JobSearchService::SearchResult",
      description: "jobs、facets、query、pageをSerializerへ渡すbackend内のvalue object。",
      kind: "value object",
      notation: "interface",
      anchor: railsReactSource("app/services/job_search_service.rb"),
    },
    {
      id: "job-model",
      label: "Job ActiveRecord model",
      description: "jobs tableとcompany associationをコード上のquery APIとして公開するModel。",
      kind: "model",
      notation: "class",
      anchor: railsReactSource("app/models/job.rb"),
    },
    {
      id: "jobs-table",
      label: "jobs records",
      description: "Job modelの背後にある永続化境界。fixtureではschema自体のclaimは置かない。",
      kind: "database",
      notation: "database",
    },
    {
      id: "job-policy-scope",
      label: "JobPolicy::Scope",
      description: "current_userに応じて検索対象となるJob relationを制限するPolicy object。",
      kind: "policy",
      notation: "class",
      anchor: railsReactSource("app/policies/job_policy.rb"),
    },
    {
      id: "jobs-page-serializer",
      label: "JobsPageSerializer",
      description:
        "SearchResultとJob modelを、browserへ渡すquery・page・facets・jobsのJSON shapeへ射影する。",
      kind: "serializer",
      notation: "class",
      anchor: railsReactSource("app/serializers/jobs_page_serializer.rb"),
    },
    {
      id: "jobs-page-payload-contract",
      label: "JobsPagePayload / JobItem",
      description:
        "Serializerが生成しReact側が読むpage payloadのshapeをTypeScript側から明示する境界contract。",
      kind: "data contract",
      notation: "interface",
      anchor: railsReactSource("app/frontend/jobs-page-contract.ts"),
    },
    {
      id: "jobs-index-view",
      label: "jobs/index.html.erb",
      description:
        "server-rendered heading、React mount node、JSON payload scriptを同じHTML documentへ配置するView。",
      kind: "view",
      notation: "component",
      anchor: railsReactSource("app/views/jobs/index.html.erb"),
    },
    {
      id: "jobs-dom-mount-contract",
      label: "jobs-page DOM mount contract",
      description:
        "#jobs-page-rootと#jobs-page-propsを、Rails ViewとReact entryが共有する境界として表すunanchored claim。証拠は両側のEdgeに置く。",
      kind: "boundary contract",
      notation: "concept",
    },
    {
      id: "jobs-react-entry",
      label: "jobs.tsx React entry",
      description:
        "mount nodeとJSON scriptをDOMから取得し、payloadをparseしてJobsPageをcreateRootでmountする。",
      kind: "React root",
      notation: "component",
      anchor: railsReactSource("app/frontend/entries/jobs.tsx"),
    },
    {
      id: "jobs-page-component",
      label: "JobsPage component",
      description:
        "initialPayloadを受け取り、検索query stateを所有し、SearchFormとResultsListへ必要なpropsを配る。",
      kind: "React component",
      notation: "component",
      anchor: railsReactSource("app/frontend/components/JobsPage.tsx"),
    },
    {
      id: "search-form-component",
      label: "SearchForm component",
      description: "queryを表示し、入力変更をonSearch callbackとして親へ返すcontrolled component。",
      kind: "React component",
      notation: "component",
      anchor: railsReactSource("app/frontend/components/SearchForm.tsx"),
    },
    {
      id: "results-list-component",
      label: "ResultsList component",
      description: "JobItem[]を受け取り、stable job IDでJobCardの集合へ展開する。",
      kind: "React component",
      notation: "component",
      anchor: railsReactSource("app/frontend/components/ResultsList.tsx"),
    },
    {
      id: "job-card-component",
      label: "JobCard component",
      description: "一つのJobItemからtitleとlocationを描画するleaf component。",
      kind: "React component",
      notation: "component",
      anchor: railsReactSource("app/frontend/components/JobCard.tsx"),
    },
  ],
  edges: [
    {
      id: "rails-react-01",
      from: "jobs-route",
      to: "jobs-controller",
      label: "GET /jobsをindex actionへdispatchする",
      directed: true,
      anchors: [railsReactSource("config/routes.rb")],
    },
    {
      id: "rails-react-02",
      from: "job-search-service",
      to: "jobs-controller",
      label: "検索済みSearchResultを返す",
      directed: true,
      anchors: [railsReactSource("app/controllers/jobs_controller.rb")],
    },
    {
      id: "rails-react-03",
      from: "job-policy-scope",
      to: "job-search-service",
      label: "current_userに見えるrelationを提供する",
      directed: true,
      anchors: [railsReactSource("app/services/job_search_service.rb")],
    },
    {
      id: "rails-react-04",
      from: "job-model",
      to: "job-search-service",
      label: "search・includes・page queryを提供する",
      directed: true,
      anchors: [railsReactSource("app/services/job_search_service.rb")],
    },
    {
      id: "rails-react-05",
      from: "jobs-table",
      to: "job-model",
      label: "ActiveRecord mappingの永続化対象になる",
      directed: true,
      anchors: [railsReactSource("app/models/job.rb")],
    },
    {
      id: "rails-react-06",
      from: "job-search-service",
      to: "job-search-result",
      label: "jobs・facets・query・pageをvalue化する",
      directed: true,
      anchors: [railsReactSource("app/services/job_search_service.rb")],
    },
    {
      id: "rails-react-07",
      from: "job-search-result",
      to: "jobs-page-serializer",
      label: "serializerの入力valueになる",
      directed: true,
      anchors: [railsReactSource("app/serializers/jobs_page_serializer.rb")],
    },
    {
      id: "rails-react-08",
      from: "jobs-page-serializer",
      to: "jobs-controller",
      label: "browser向けpage payloadを返す",
      directed: true,
      anchors: [railsReactSource("app/controllers/jobs_controller.rb")],
    },
    {
      id: "rails-react-09",
      from: "jobs-page-serializer",
      to: "jobs-page-payload-contract",
      label: "JSON field shapeを実装する",
      directed: true,
      anchors: [railsReactSource("app/serializers/jobs_page_serializer.rb")],
    },
    {
      id: "rails-react-10",
      from: "jobs-controller",
      to: "jobs-index-view",
      label: "@page_payloadをassignしてrenderする",
      directed: true,
      anchors: [railsReactSource("app/controllers/jobs_controller.rb")],
    },
    {
      id: "rails-react-11",
      from: "jobs-page-payload-contract",
      to: "jobs-index-view",
      label: "JSON scriptとしてHTMLへ埋め込まれる",
      directed: true,
      anchors: [railsReactSource("app/views/jobs/index.html.erb")],
    },
    {
      id: "rails-react-12",
      from: "jobs-index-view",
      to: "jobs-dom-mount-contract",
      label: "mount nodeとpayload scriptを宣言する",
      directed: true,
      anchors: [railsReactSource("app/views/jobs/index.html.erb")],
    },
    {
      id: "rails-react-13",
      from: "jobs-dom-mount-contract",
      to: "jobs-react-entry",
      label: "DOM IDをReactの入口として公開する",
      directed: true,
      anchors: [railsReactSource("app/frontend/entries/jobs.tsx")],
    },
    {
      id: "rails-react-14",
      from: "jobs-page-payload-contract",
      to: "jobs-react-entry",
      label: "parse後のprops型として読まれる",
      directed: true,
      anchors: [railsReactSource("app/frontend/entries/jobs.tsx")],
    },
    {
      id: "rails-react-15",
      from: "jobs-react-entry",
      to: "jobs-page-component",
      label: "createRootでinitialPayloadを渡してmountする",
      directed: true,
      anchors: [railsReactSource("app/frontend/entries/jobs.tsx")],
    },
    {
      id: "rails-react-16",
      from: "jobs-page-component",
      to: "search-form-component",
      label: "queryとonSearch callbackをpropsで渡す",
      directed: true,
      anchors: [railsReactSource("app/frontend/components/JobsPage.tsx")],
    },
    {
      id: "rails-react-17",
      from: "search-form-component",
      to: "jobs-page-component",
      label: "入力変更をonSearchで返す",
      directed: true,
      anchors: [railsReactSource("app/frontend/components/SearchForm.tsx")],
    },
    {
      id: "rails-react-18",
      from: "jobs-page-component",
      to: "results-list-component",
      label: "JobItem[]をpropsで渡す",
      directed: true,
      anchors: [railsReactSource("app/frontend/components/JobsPage.tsx")],
    },
    {
      id: "rails-react-19",
      from: "results-list-component",
      to: "job-card-component",
      label: "各JobItemをleaf componentへ渡す",
      directed: true,
      anchors: [railsReactSource("app/frontend/components/ResultsList.tsx")],
    },
    {
      id: "rails-react-20",
      from: "job-card-component",
      to: "jobs-page-payload-contract",
      label: "JobItem contractをimportする",
      directed: true,
      anchors: [railsReactSource("app/frontend/components/JobCard.tsx")],
    },
  ],
};

function syntheticNodes(size: number): StructureNode[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `node-${String(index).padStart(3, "0")}`,
    label:
      index === 7
        ? "意味を変えずに折り返す必要がある、Producerが意図的に長く書いたclaimのラベル"
        : index < 5
          ? `共有依存 ${index + 1}`
          : `コンポーネント ${index + 1}`,
    ...(index % 11 === 0
      ? {
          description: "focus、近傍密度、layout continuityを試すためだけに用意した合成claim。",
        }
      : {}),
    kind: index < 5 ? "共有依存" : index % 9 === 0 ? "概念" : "コンポーネント",
  }));
}

function addEdge(
  edges: StructureEdge[],
  id: string,
  from: number,
  to: number,
  label: string,
  directed = true,
): void {
  edges.push({
    id,
    from: `node-${String(from).padStart(3, "0")}`,
    to: `node-${String(to).padStart(3, "0")}`,
    label,
    directed,
  });
}

function syntheticStructure(size: 20 | 100 | 500): Structure {
  const edges: StructureEdge[] = [];
  const componentSize = size === 20 ? 8 : size === 100 ? 24 : 40;
  const disconnectedStart = size - Math.max(2, Math.floor(size * 0.04));
  for (let index = 5; index < size; index += 1) {
    if (index >= disconnectedStart) {
      if (index > disconnectedStart) {
        addEdge(edges, `disconnected-${index}`, index - 1, index, "非接続領域の内部で続く");
      }
      continue;
    }
    if (index % componentSize !== 0) {
      addEdge(edges, `linear-${index}`, index - 1, index, "制御を渡す");
    }
    addEdge(edges, `shared-${index}`, index, index % 5, "共有契約に依存する");
    if (index % 7 === 0 && index >= 7) {
      addEdge(edges, `cycle-${index}`, index, Math.max(5, index - 6), "完了を戻して報告する");
    }
    if (index % 13 === 0 && index + 2 < size) {
      addEdge(edges, `cross-${index}`, index, index + 2, "派生状態を共有する", false);
    }
  }
  const fanOut = Math.min(size - 1, 18);
  for (let index = 1; index <= fanOut; index += 1) {
    addEdge(edges, `hub-${index}`, 0, index, "意味による順位付けなしで分岐する");
  }
  return {
    id: `synthetic-${size}`,
    title: `合成グラフ ${size} Node · 混合トポロジー`,
    scope: `描画と操作の計測だけを目的に、直線領域、fan-out、fan-in、cycle、共有依存、非接続コンポーネントを${size}個のstable Nodeで組み合わせたグラフ。`,
    initialFocus: "node-000",
    nodes: syntheticNodes(size),
    edges,
  };
}

function syntheticUpdate(structure: Structure): Structure {
  const removedIds = new Set(structure.nodes.slice(-2).map((node) => node.id));
  const nodes = structure.nodes.filter((node) => !removedIds.has(node.id));
  const edges = structure.edges.filter(
    (edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to),
  );
  const addedNodes: StructureNode[] = [
    {
      id: `${structure.id}-update-a`,
      label: "再現したcurrent valueで追加されたNode A",
      kind: "新規コンポーネント",
    },
    {
      id: `${structure.id}-update-b`,
      label: "再現したcurrent valueで追加されたNode B",
      kind: "新規概念",
    },
  ];
  return {
    ...structure,
    title: `${structure.title} · current value更新の再現`,
    nodes: [...nodes, ...addedNodes],
    edges: [
      ...edges,
      {
        id: `${structure.id}-update-edge-a`,
        from: structure.initialFocus ?? nodes[0]?.id ?? addedNodes[0]!.id,
        to: addedNodes[0]!.id,
        label: "新しく公開されたrelationを接続する",
        directed: true,
      },
      {
        id: `${structure.id}-update-edge-b`,
        from: addedNodes[0]!.id,
        to: addedNodes[1]!.id,
        label: "共通IDを動かさずに追加する",
        directed: true,
      },
    ],
  };
}

const synthetic20 = syntheticStructure(20);
const synthetic100 = syntheticStructure(100);
const synthetic500 = syntheticStructure(500);

export const structureFixtures: StructureFixture[] = [
  {
    category: "Code relationships",
    structure: rvwServiceCodeStructure,
    temporary: true,
  },
  {
    category: "Code relationships",
    structure: documentWorkspaceCodeStructure,
    temporary: true,
  },
  {
    category: "Code relationships",
    structure: gitClientCodeStructure,
    temporary: true,
  },
  {
    category: "Code relationships",
    structure: railsReactPageCodeStructure,
    layout: "bidirectional",
    sourceChangeKinds: {
      [`${railsReactFixtureRoot}/app/views/jobs/index.html.erb`]: "modified",
      [`${railsReactFixtureRoot}/app/frontend/entries/jobs.tsx`]: "added",
    },
    temporary: true,
  },
  {
    category: "Flow comparisons",
    structure: commentWatchStructure,
    updatedStructure: commentWatchUpdate,
    walkthroughMermaid: `flowchart LR
  Human[人間のコメント] -->|送信する| App[Application]
  App -->|保存する| DB[(SQLiteの投稿)]
  DB -->|追記する| Events[イベント列]
  Events -->|ポーリングする| CLI[comment watch]
  CLI -->|フレームを送る| Driver[監視ドライバー]
  Driver -->|取り込む| State[(タスク状態)]
  State -->|確保する| Ack[受付応答]
  Ack -->|配送する| Worker[新しいワーカー]
  Worker -->|編集する| Final[最終結果]
  Final -->|通常返信のイベント| Events`,
    temporary: true,
  },
  {
    category: "Flow comparisons",
    structure: walkthroughPublishStructure,
    walkthroughMermaid: `flowchart LR
  Skill[rvw-walkthrough Skill] -->|執筆する| JSON[公開JSON]
  JSON -->|標準入力| CLI[CLI]
  CLI -->|呼び出す| Validation[検証]
  Validation -->|保持する| Git[正確なGit commit]
  Git -->|書き込みを保護する| SQLite[(現在のWalkthrough)]
  SQLite -->|ポーリングで無効化する| Viewer[Walkthroughタブ]
  Viewer -->|人間が参照を選ぶ| Resolve[最新 / fallbackの解決]
  Resolve -->|開く| Code[正確なcode]
  Code -. タブを維持する .-> Viewer`,
    temporary: true,
  },
  {
    category: "Flow comparisons",
    structure: documentNavigationStructure,
    walkthroughMermaid: `flowchart LR
  Ref[Source affordance] -->|通常| Left[左ペイン]
  Ref -->|Cmd / Ctrl| Right[右ペイン]
  Left --> Workspace[文書workspace]
  Right --> Workspace
  Workspace -->|取得する| Git[正確なGit文書]
  Git --> Viewer[DocumentViewer]
  Workspace -->|維持する| Origin[起点タブ]
  Viewer -. 戻る .-> Origin`,
    temporary: true,
  },
  {
    category: "Synthetic",
    structure: synthetic20,
    updatedStructure: syntheticUpdate(synthetic20),
    temporary: true,
  },
  {
    category: "Synthetic",
    structure: synthetic100,
    updatedStructure: syntheticUpdate(synthetic100),
    temporary: true,
  },
  {
    category: "Synthetic",
    structure: synthetic500,
    updatedStructure: syntheticUpdate(synthetic500),
    temporary: true,
  },
];

export function structureFixtureById(id: string): StructureFixture | undefined {
  return structureFixtures.find((fixture) => fixture.structure.id === id);
}
