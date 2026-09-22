import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import open from "open";
import { RvwService } from "../src/application/rvw-service.js";
import type { GitHubPullRequest } from "../src/domain/models.js";
import { RvwDatabase } from "../src/infrastructure/db/database.js";
import { GitClient } from "../src/infrastructure/git/git-client.js";
import { startServer } from "../src/server/start-server.js";
import { createGitRepository, git } from "../test/fixtures/git-repository.js";

// Only GitHub metadata is supplied locally. Documents, diffs and navigation use
// the production service, actual Git objects and the real Ruby parser worker.
const port = Number(process.env.RVW_NAVIGATION_DEMO_PORT ?? 43119);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("RVW_NAVIGATION_DEMO_PORT must be an integer from 0 to 65535");
const root = path.resolve(import.meta.dirname, "..");
const repository = realpathSync(createGitRepository("rvw-rails-navigation-demo-"));
function write(file: string, content: string) {
  const destination = path.join(repository, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}
write(
  "README.md",
  `# Checkout review

Ruby / Rails のコード探索デモです。実際の Git の変更前・変更後を表示しています。

1. Cmd / Ctrl + P で orders_controller.rb を開く
2. Checkout を Cmd / Ctrl + click → 定義候補を表示
3. 候補を Cmd / Ctrl + click → 右ペインに開く
4. reserve! から在庫処理へ進み、ブラウザの「戻る」で戻る

変更前の InventoryReservation は旧パス、変更後は移動後のパスを指します。
Rails が自動生成するメソッドや外部 gem の定義は対象外です。
`,
);
write(
  "app/models/order.rb",
  `class Order < ApplicationRecord
  belongs_to :customer
  has_many :line_items

  MAX_ITEMS = 50

  def total_cents
    line_items.sum { |item| item.quantity * item.unit_price_cents }
  end

  def confirm!
    update!(status: "confirmed")
  end
end
`,
);
write(
  "app/services/inventory_reservation.rb",
  `class InventoryReservation
  def initialize(order)
    @order = order
  end

  def reserve!
    @order.line_items.each do |item|
      item.product.decrement!(:available_units, item.quantity)
    end
  end
end
`,
);
write(
  "app/services/orders/checkout.rb",
  `module Orders
  class Checkout
    def initialize(order)
      @order = order
    end

    def call
      InventoryReservation.new(@order).reserve!
      PaymentGateway.charge(@order.total_cents)
      @order.confirm!
    end
  end
end
`,
);
write(
  "app/services/refunds/checkout.rb",
  `module Refunds
  # 同名の定義がある場合も、呼び先を断定せず候補として表示する。
  class Checkout
    def initialize(order)
      @order = order
    end

    def call
      PaymentGateway.refund(@order.total_cents)
    end
  end
end
`,
);
write(
  "app/controllers/orders_controller.rb",
  `class OrdersController < ApplicationController
  def create
    order = Order.find(params[:id])
    InventoryReservation.new(order).reserve!
    order.confirm!
    redirect_to order_path(order)
  end
end
`,
);
git(repository, "add", ".");
git(repository, "commit", "-m", "Add order and inventory services");
write(
  "frontend/Button.tsx",
  `type ButtonProps = { title: string };

export function Button({ title }: ButtonProps) {
  return <button type="submit">{title}</button>;
}
`,
);
write(
  "frontend/legacy/Button.jsx",
  `// 同じ名前の別コンポーネントも候補として表示する。
export const Button = () => <button>Legacy checkout</button>;
`,
);
write(
  "frontend/CheckoutPage.tsx",
  `import { Button } from "./Button";

export function CheckoutPage() {
  return <Button title="購入する" />;
}
`,
);
git(repository, "add", ".");
git(repository, "commit", "-m", "Add React checkout components");
const baseOid = git(repository, "rev-parse", "HEAD");
git(repository, "switch", "-c", "feature/checkout-service");
mkdirSync(path.join(repository, "app/services/inventory"), { recursive: true });
git(
  repository,
  "mv",
  "app/services/inventory_reservation.rb",
  "app/services/inventory/reservation.rb",
);
write(
  "app/controllers/orders_controller.rb",
  `class OrdersController < ApplicationController
  def create
    order = Order.find(params[:id])
    Orders::Checkout.new(order).call
    redirect_to order_path(order), notice: "注文を確定しました"
  end
end
`,
);
write(
  "app/services/orders/checkout.rb",
  `module Orders
  class Checkout
    def initialize(order)
      @order = order
    end

    def call
      # 変更前後で同じ blob の在庫サービスを別のパスから読む。
      InventoryReservation.new(@order).reserve!
      PaymentGateway.charge(@order.total_cents)
      @order.confirm!
    end
  end
end
`,
);
write(
  "frontend/CheckoutPage.tsx",
  `import { Button } from "./Button";

export function CheckoutPage() {
  return <Button title="注文を確定する" />;
}
`,
);
git(repository, "add", ".");
git(repository, "commit", "-m", "Route order checkout through service and reorganize inventory");
const headOid = git(repository, "rev-parse", "HEAD");
const metadata: GitHubPullRequest = {
  host: "github.com",
  owner: "acme",
  repository: "review-repo",
  number: 7,
  url: "https://github.com/acme/review-repo/pull/7",
  authorLogin: "rails-reviewer",
  headRepositoryOwner: "acme",
  headRepositoryName: "review-repo",
  title: "注文確定の改善 — Ruby / React コード探索",
  body: `## コードナビゲーションのデモ

注文確定の責務を controller から service へ移し、在庫処理のファイルを整理します。

### 試すこと

- ファイル一覧から orders_controller.rb を開き、変更後の Checkout を Cmd / Ctrl + click。
- Orders と Refunds に同名の class があるため、定義候補から Orders を選ぶ。
- 候補を Cmd / Ctrl + click すると右ペインで比較しながら読める。
- InventoryReservation や reserve! から在庫処理に進み、ブラウザの「戻る」で戻る。
- 変更前の InventoryReservation は移動前のファイルを開く。
- React: frontend/CheckoutPage.tsx の Button を Cmd / Ctrl + click。TSX/JSX の候補から対象を開く。

定義候補は Git の表示中のコミットに対応します。呼び先の意味解析・Rails の動的メソッド・外部 gem は対象外です。`,
  baseRefName: "main",
  baseOid,
  headRefName: "feature/checkout-service",
  headOid,
  createdAt: "2026-09-22T00:00:00Z",
  updatedAt: "2026-09-22T00:00:00Z",
  state: "OPEN",
  isDraft: false,
  approvalCount: 0,
};
const database = new RvwDatabase({
  filePath: ":memory:",
  migrationsDirectory: path.join(root, "migrations"),
});
const client = new GitClient();
const service = new RvwService(database, client, {
  doctor: () => Promise.resolve({ version: "local navigation demo", authenticated: true }),
  getPullRequest: () => Promise.resolve(metadata),
  getPullRequestStatuses: (references) =>
    Promise.resolve(
      references.map(() => ({
        status: "fulfilled",
        value: { state: "OPEN", isDraft: false, approvalCount: 0 },
      })),
    ),
  getAttachment: () => Promise.reject(new Error("This local demo contains no GitHub attachments")),
});
const pullRequest = database.upsertPullRequest(
  metadata,
  { localRepositoryPath: repository, gitCommonDir: path.join(repository, ".git") },
  baseOid,
);
await client.ensureCommitRef(repository, 7, headOid);
const server = await startServer(service, { port, staticDirectory: path.join(root, "dist/web") });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  service.close();
  await server.close();
  database.close();
  rmSync(repository, { recursive: true, force: true });
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
const url = `${server.origin}/?pullRequestId=${pullRequest.id}`;
process.stdout.write(`rvw Ruby / React navigation demo: ${url}\nRepository: ${repository}\n`);
if (!process.argv.includes("--no-open")) await open(url);
