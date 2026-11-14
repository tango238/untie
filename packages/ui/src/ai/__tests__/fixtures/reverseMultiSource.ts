// 「ソースコードから作成」の、ソースが複数のフォルダに分かれたときのテスト用フィクスチャ (架空のネットショップ「あおぞら雑貨店」)。
// バックエンド (API・データ・夜間のジョブ)・管理画面 (店のスタッフが注文を承認する)・フロント画面 (お客様が注文する) の 3 つのソース。
// フロントの API 呼び出しがバックエンドのルートに対応し、お客様 (フロント) が出した注文を、店のスタッフ (管理画面) が承認する、
// と担当の違う業務がソースをまたいでつながる。ソースごとに .env (秘密の値) を持つ。会社名・数・値はすべて架空。
// パス → 中身 の表にしてあるので、ディスクに書き出して、実際のフォルダとしても使える (writeMultiFixtureSources)。
import type { DatabaseDraft, ScreenDraft, SitemapDraft } from "../../designDraft";
import { memorySourceTree, type LabeledSource } from "../../sourceTree";
import type { ModelSpec } from "../../spec";
import { FIXTURE_DSL } from "./reverseDraft";

export const MULTI_SECRETS = {
  バックエンド: "sk-live-aozora-api-0000-NOT-A-REAL-KEY",
  管理画面: "sk-live-aozora-admin-1111-NOT-A-REAL-KEY",
  フロント画面: "sk-live-aozora-shop-2222-NOT-A-REAL-KEY",
} as const;

export const MULTI_LABELS = ["バックエンド", "管理画面", "フロント画面"] as const;
export const MULTI_FOLDERS = { バックエンド: "aozora-api", 管理画面: "aozora-admin", フロント画面: "aozora-shop" } as const;

export const MULTI_SOURCE_FILES: Record<(typeof MULTI_LABELS)[number], Record<string, string>> = {
  バックエンド: {
    "README.md": `# あおぞら雑貨店 API

お客様サイトと管理画面が使う API と、夜間のジョブです。

- API: src/routes/orders.ts (お客様向け)・src/routes/adminOrders.ts (管理画面向け)
- 夜間の集計: src/jobs/nightly.ts
- スキーマ: prisma/schema.prisma
`,
    ".env": `DATABASE_URL=postgres://api:${MULTI_SECRETS.バックエンド}@localhost/aozora\n`,
    "build/bundle.js": "const compiled = true; // build の成果物\n",
    "prisma/schema.prisma": FIXTURE_DSL,
    "src/routes/orders.ts": `import { Router } from "express";

export const orders = Router();

// お客様が注文を出す (フロント画面の注文入力から)
orders.post("/api/orders", async (req, res) => {
  if (!req.body.customer) return res.status(400).json({ error: "お客様名は必須です" });
  const order = await db.order.create({ data: { ...req.body, status: "PENDING", orderedAt: new Date() } });
  res.json(order);
});

// お客様が注文の状況を見る (フロント画面の注文状況から)
orders.get("/api/orders/:id", async (req, res) => {
  res.json(await db.order.findUnique({ where: { id: req.params.id }, include: { items: true } }));
});
`,
    "src/routes/adminOrders.ts": `import { Router } from "express";
import { requireStaff } from "../auth";

export const adminOrders = Router();

// 店のスタッフが、承認待ちの注文を探す (管理画面の承認待ち一覧から)
adminOrders.get("/api/admin/orders", requireStaff, async (req, res) => {
  res.json(await db.order.findMany({ where: { status: String(req.query.status ?? "PENDING") } }));
});

// 店のスタッフが注文を承認する (管理画面の注文承認から)
adminOrders.post("/api/admin/orders/:id/approve", requireStaff, async (req, res) => {
  res.json(await db.order.update({ where: { id: req.params.id }, data: { status: "APPROVED" } }));
});
`,
    "src/jobs/nightly.ts": `// 毎日 23:30 に、その日に承認された注文を集計する (人は関わらない)
cron.schedule("30 23 * * *", async () => {
  await aggregateSales(new Date());
});
`,
  },
  管理画面: {
    "README.md": `# あおぞら雑貨店 管理画面

店のスタッフが、お客様の注文を承認する社内向けの画面です。ログインにはスタッフ用のアカウントが要ります。
`,
    ".env": `VITE_API_BASE=https://admin.example.invalid\nADMIN_SESSION_SECRET=${MULTI_SECRETS.管理画面}\n`,
    "build/index.html": "<html></html>\n",
    "src/pages/PendingList.tsx": `export function PendingList() {
  // 承認待ちの注文を探す
  const orders = useFetch("/api/admin/orders?status=PENDING");
  return (
    <section>
      <h1>承認待ちの注文</h1>
      <table>{orders.map((o) => <tr onClick={() => navigate("/orders/" + o.id)}><td>{o.customer}</td><td>{o.status}</td></tr>)}</table>
    </section>
  );
}
`,
    "src/pages/ApproveOrder.tsx": `export function ApproveOrder({ id }: { id: string }) {
  const approve = () => fetch("/api/admin/orders/" + id + "/approve", { method: "POST" }).then(() => navigate("/pending"));
  return (
    <section>
      <dl><dt>お客様名</dt><dd>{order.customer}</dd></dl>
      <button onClick={approve}>承認する</button>
      <Link to="/pending">一覧へ戻る</Link>
    </section>
  );
}
`,
  },
  フロント画面: {
    "README.md": `# あおぞら雑貨店 ショップ

お客様が、雑貨を注文して、注文の状況を見るサイトです。ログインは要りません。
`,
    ".env": `VITE_PUBLIC_KEY=${MULTI_SECRETS.フロント画面}\n`,
    "build/index.html": "<html></html>\n",
    "src/pages/OrderNew.tsx": `export function OrderNew() {
  const submit = (data: FormData) =>
    fetch("/api/orders", { method: "POST", body: data }).then((r) => r.json()).then((o) => navigate("/orders/" + o.id));
  return (
    <form onSubmit={submit}>
      <input name="customer" placeholder="お名前" required />
      <input name="quantity" type="number" />
      <button type="submit">注文する</button>
    </form>
  );
}
`,
    "src/pages/OrderStatus.tsx": `export function OrderStatus({ id }: { id: string }) {
  const order = useFetch("/api/orders/" + id);
  return (
    <section>
      <dl><dt>お名前</dt><dd>{order.customer}</dd><dt>状態</dt><dd>{order.status}</dd></dl>
    </section>
  );
}
`,
  },
};

/** ラベル付きのメモリ上のソース (除外規則は木と道具が適用する) */
export function multiFixtureSources(): LabeledSource[] {
  return MULTI_LABELS.map((label) => ({ label, tree: memorySourceTree(MULTI_FOLDERS[label], MULTI_SOURCE_FILES[label]) }));
}

/**
 * ディスクに書き出す。テストでは使わない (テストは multiFixtureSources のメモリ上の木を使う)。
 * ブラウザでの確認 (開発サーバーのダイアログで、実際のフォルダとして選ぶ。スクリーンショット・実際の API での通し確認) 用で、
 * dir は空のフォルダ。<dir>/<フォルダ名>/ に 1 ソースずつ書く
 */
export async function writeMultiFixtureSources(dir: string): Promise<Record<string, string>> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const out: Record<string, string> = {};
  for (const label of MULTI_LABELS) {
    const root = join(dir, MULTI_FOLDERS[label]);
    out[label] = root;
    for (const [path, text] of Object.entries(MULTI_SOURCE_FILES[label])) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 下書き (AI の出力の台本)

export const MULTI_SHOP = "ネットショップ";
export const MULTI_ADMIN = "注文管理画面";
export const MULTI_API = "注文サーバー";

/** 分析の下書き。お客様 (外部アクター) が出した注文を、店のスタッフ (アクター) が承認する。システムは、お客様のサイト・管理画面・サーバーの 3 つ */
export const MULTI_SPEC: ModelSpec = {
  system_name: "あおぞら雑貨店のネット注文",
  overview:
    "お客様が雑貨をネットで注文し、店のスタッフが承認する。システムは、お客様が使うサイト (ネットショップ)・店のスタッフが使う管理画面 (注文管理画面)・どちらからも呼ばれる API とジョブ (注文サーバー) に分けた (使う人と入口が違うため)。",
  actors: [{ name: "店のスタッフ" }],
  external_actors: [{ name: "お客様" }],
  systems: [
    { name: MULTI_SHOP, description: "お客様が注文する公開サイト (フロント画面)" },
    { name: MULTI_ADMIN, description: "店のスタッフが注文を承認する社内向けの画面 (管理画面)" },
    { name: MULTI_API, description: "注文の API と夜間のジョブ (バックエンド)" },
  ],
  informations: [{ name: "注文", description: "お客様からの注文 1 件", related: ["商品"] }, { name: "商品", description: "売っている雑貨" }],
  state_groups: [{ name: "注文の状態", states: [{ name: "承認待ち" }, { name: "承認済み" }] }],
  businesses: [
    {
      name: "ネット注文の受付",
      main_actors: ["店のスタッフ"],
      activities: [
        {
          name: "注文を出す",
          performers: ["お客様"],
          usecases: [
            { name: "注文を送る", reads: ["商品"], writes: ["注文"], to_states: ["承認待ち"] },
            { name: "注文の状況を見る", reads: ["注文"] },
          ],
        },
        {
          name: "注文を承認する",
          performers: ["店のスタッフ"],
          usecases: [
            { name: "承認待ちの注文を探す", reads: ["注文"], from_states: ["承認待ち"] },
            { name: "注文を承認する", reads: ["注文"], writes: ["注文"], from_states: ["承認待ち"], to_states: ["承認済み"] },
          ],
        },
      ],
    },
  ],
  screens: [
    { name: "注文入力", description: "お客様が注文を入力して送る (フロント画面/src/pages/OrderNew.tsx)", system: MULTI_SHOP, usecase: "注文を送る" },
    { name: "注文の状況", description: "お客様が注文の状況を見る (フロント画面/src/pages/OrderStatus.tsx)", system: MULTI_SHOP, usecase: "注文の状況を見る" },
    { name: "承認待ち一覧", description: "スタッフが承認待ちの注文を探す (管理画面/src/pages/PendingList.tsx)", system: MULTI_ADMIN, usecase: "承認待ちの注文を探す" },
    { name: "注文承認", description: "スタッフが注文を承認する (管理画面/src/pages/ApproveOrder.tsx)", system: MULTI_ADMIN, usecase: "注文を承認する" },
  ],
  events: [{ name: "夜間の締めになった", raised_by: [MULTI_API], usecases: [{ name: "売上を集計する", reads: ["注文"], targets: [MULTI_API] }] }],
};

/** バックエンドのスキーマ。画面だけのシステム (ネットショップ・注文管理画面) は DB を持たず、これに結ぶ */
export const MULTI_DATABASE: DatabaseDraft = {
  system: MULTI_API,
  database_name: "注文DB",
  dsl: FIXTURE_DSL,
  tables: [
    { table: "Order", informations: ["注文"] },
    { table: "OrderItem", informations: ["注文", "商品"] },
    { table: "Product", informations: ["商品"] },
  ],
};

export const MULTI_SITEMAPS: Record<string, SitemapDraft> = {
  [MULTI_SHOP]: { system: MULTI_SHOP, transitions: [{ from: "注文入力", to: "注文の状況", via: "afterSubmit", label: "注文する" }] },
  [MULTI_ADMIN]: {
    system: MULTI_ADMIN,
    transitions: [
      { from: "承認待ち一覧", to: "注文承認", via: "row" },
      { from: "注文承認", to: "承認待ち一覧", via: "button", label: "一覧へ戻る" },
    ],
  },
};

/** 画面 UI。フロント・管理画面の項目を、バックエンドの Order / OrderItem のテーブルの列に結ぶ (database は書かない: 結ぶ先は 1 つ) */
export const MULTI_SCREENS: ScreenDraft[] = [
  {
    screen: "注文入力",
    view: {
      title: "注文入力",
      goal: "お客様が注文を入力して送る",
      sections: [
        {
          id: "input",
          title: "ご注文",
          kind: "form",
          fields: [
            { item: "customer", label: "お名前", component: "text", required: true, example: "青空 太郎" },
            { item: "quantity", label: "数量", component: "number", example: "2" },
          ],
        },
      ],
      primaryAction: { id: "order", label: "注文する", kind: "submit", to: "注文の状況" },
    },
    bindings: [
      { item: "customer", table: "Order", column: "customer" },
      { item: "quantity", table: "OrderItem", column: "quantity" },
    ],
  },
  {
    screen: "注文の状況",
    view: {
      title: "注文の状況",
      goal: "お客様が注文の状況を見る",
      sections: [
        {
          id: "info",
          title: "ご注文",
          kind: "readonly",
          fields: [
            { item: "customer", label: "お名前", component: "text" },
            { item: "status", label: "状態", component: "status" },
          ],
        },
      ],
    },
    bindings: [
      { item: "customer", table: "Order", column: "customer" },
      { item: "status", table: "Order", column: "status" },
    ],
  },
  {
    screen: "承認待ち一覧",
    view: {
      title: "承認待ち一覧",
      goal: "スタッフが承認待ちの注文を探す",
      sections: [{ id: "res", title: "承認待ち", kind: "list", list: { columns: [{ id: "customer", label: "お客様名", to: "注文承認" }, { id: "status", label: "状態", type: "status" }] } }],
    },
    bindings: [
      { item: "res.customer", table: "Order", column: "customer" },
      { item: "res.status", table: "Order", column: "status" },
    ],
  },
  {
    screen: "注文承認",
    view: {
      title: "注文承認",
      goal: "スタッフが注文を承認する",
      sections: [{ id: "info", title: "注文", kind: "readonly", fields: [{ item: "customer", label: "お客様名", component: "text" }] }],
      primaryAction: { id: "approve", label: "承認する", kind: "submit", to: "承認待ち一覧" },
      secondaryActions: [{ id: "back", label: "一覧へ戻る", kind: "navigate", to: "承認待ち一覧" }],
    },
    bindings: [{ item: "customer", table: "Order", column: "customer" }],
  },
];
