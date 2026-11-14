// 「ソースコードから作成」の下書きのフィクスチャ (架空の小さな文具店の注文アプリ)。
// 後続フェーズ (生成の流れのテスト) でも、AI の出力の台本として使う。
import type { DatabaseDraft, ScreenDraft, SitemapDraft } from "../../designDraft";
import type { ModelSpec } from "../../spec";

/** 分析の下書き (画面・イベントを含む) */
export const FIXTURE_SPEC: ModelSpec = {
  system_name: "ひだまり文具店の注文アプリ",
  overview: "店頭と電話の注文を受け付け、在庫を引き当てて、発送の準備まで行う",
  actors: [{ name: "受付担当" }],
  external_actors: [{ name: "お客様" }],
  systems: [{ name: "注文管理システム", description: "注文と在庫を扱う社内のウェブアプリ" }],
  ledgers: [{ name: "納品書" }],
  informations: [
    { name: "注文", description: "お客様からの注文 1 件", related: ["商品"] },
    { name: "商品", description: "売っている文具" },
  ],
  state_groups: [{ name: "注文の状態", states: [{ name: "受付済み" }, { name: "引当済み" }] }],
  businesses: [
    {
      name: "注文受付",
      main_actors: ["受付担当"],
      activities: [
        {
          name: "注文を受ける",
          performers: ["受付担当", "お客様"],
          usecases: [
            { name: "注文を登録する", reads: ["商品"], writes: ["注文"], to_states: ["受付済み"] },
            { name: "注文を検索する", reads: ["注文"] },
            { name: "注文を確認する", reads: ["注文", "商品"] },
          ],
        },
        {
          name: "納品書を書く",
          performers: ["受付担当"],
          trigger_events: ["在庫が引き当てられた"],
          usecases: [{ name: "納品書に記入する", reads: ["注文"], targets: ["納品書"] }],
        },
      ],
    },
  ],
  screens: [
    { name: "注文登録", description: "注文を入力して登録する", system: "注文管理システム", usecase: "注文を登録する" },
    { name: "注文一覧", description: "注文を探す", system: "注文管理システム", usecase: "注文を検索する" },
    { name: "注文詳細", description: "注文の内容を確かめる", system: "注文管理システム", usecase: "注文を確認する" },
  ],
  events: [
    {
      name: "注文が登録された",
      raised_by: ["注文を登録する"],
      usecases: [{ name: "在庫を引き当てる", reads: ["商品"], writes: ["注文"], from_states: ["受付済み"], to_states: ["引当済み"], targets: ["注文管理システム"] }],
    },
    { name: "在庫が引き当てられた", raised_by: ["在庫を引き当てる"] },
    { name: "夜間の締めになった", raised_by: ["注文管理システム"], usecases: [{ name: "売上を集計する", reads: ["注文"], targets: ["注文管理システム"] }] },
  ],
};

export const FIXTURE_DSL = `// 注文
model Order {
  id         String   @id
  customer   String
  orderedAt  DateTime
  status     String
  items      OrderItem[]
}

// 注文の明細 (商品)
model OrderItem {
  id        String  @id
  orderId   String
  order     Order   @relation(fields: [orderId], references: [id])
  productId String
  product   Product @relation(fields: [productId], references: [id])
  quantity  Int
}

// 商品
model Product {
  id    String  @id
  name  String
  price Int
  items OrderItem[]
}
`;

export const FIXTURE_SYSTEM = "注文管理システム";

export const FIXTURE_DATABASE: DatabaseDraft = {
  system: FIXTURE_SYSTEM,
  database_name: "注文DB",
  dsl: FIXTURE_DSL,
  tables: [
    { table: "Order", informations: ["注文"] },
    { table: "OrderItem", informations: ["注文", "商品"] },
    { table: "Product", informations: ["商品"] },
  ],
};

export const FIXTURE_SITEMAP: SitemapDraft = {
  system: FIXTURE_SYSTEM,
  transitions: [
    { from: "注文一覧", to: "注文詳細", via: "row" },
    { from: "注文登録", to: "注文一覧", via: "afterSubmit", label: "登録する" },
    { from: "注文詳細", to: "注文一覧", via: "button", label: "一覧へ戻る" },
  ],
};

export const FIXTURE_SCREENS: ScreenDraft[] = [
  {
    screen: "注文登録",
    view: {
      title: "注文登録",
      goal: "注文を入力して登録する",
      sections: [
        {
          id: "input",
          title: "注文",
          kind: "form",
          fields: [
            { item: "customer", label: "お客様名", component: "text", required: true, example: "山田 花子" },
            { item: "quantity", label: "数量", component: "number", example: "3" },
          ],
        },
      ],
      primaryAction: { id: "register", label: "登録する", kind: "submit", to: "注文一覧" },
    },
    bindings: [
      { item: "customer", table: "Order", column: "customer" },
      { item: "quantity", table: "OrderItem", column: "quantity" },
    ],
  },
  {
    screen: "注文一覧",
    view: {
      title: "注文一覧",
      goal: "注文を探す",
      sections: [
        { id: "cond", title: "条件", kind: "form", fields: [{ item: "keyword", label: "お客様名", component: "text" }] },
        { id: "res", title: "結果", kind: "list", list: { columns: [{ id: "customer", label: "お客様名", to: "注文詳細" }, { id: "status", label: "状態", type: "status" }] } },
      ],
    },
    bindings: [
      { item: "keyword", table: "Order", column: "customer" },
      { item: "res.customer", table: "Order", column: "customer" },
      { item: "res.status", table: "Order", column: "status" },
    ],
  },
];
