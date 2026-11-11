import { createNetshopSample } from "@untie/core/sample";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDatabase, addDesignScreens, addTransition, setDatabaseDesign, setDesignDatabases } from "@untie/core/model/commands";
import { emptyModel, type UntieModel } from "@untie/core/model/types";
import { okModel } from "@untie/core/testing";
import type { ChatOptions } from "../chat";

const fake = vi.hoisted(() => ({ tool: [] as unknown[], results: [] as { ok: boolean; content: string }[], texts: [] as string[], sent: [] as string[] }));
vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    createChatSession: (_p: string, o: ChatOptions) => ({
      seed: () => {},
      send: async (text: string) => {
        fake.sent.push(text);
        while (fake.tool.length > 0) {
          const r = await o.runTool("submit_screen", fake.tool.shift());
          fake.results.push(r);
          if (r.ok) break;
        }
        return fake.texts.shift() ?? "";
      },
    }),
  };
});

const { generateScreen, readScreenProposal, sanitizeBindings, screenRequest, screenSystemPrompt } = await import("../designScreen");

const DSL = `model Item {
  id    String @id
  name  String
  price Int
  sale  Sale?
}

model Sale {
  id String @id
}
`;

function setup(): UntieModel {
  const m0 = emptyModel();
  m0.elements = [
    { id: "sys_a", kind: "system", name: "予約システム" },
    { id: "scr_1", kind: "screen", name: "予約検索", description: "予約を探す", systemId: "sys_a" },
    { id: "info_1", kind: "information", name: "商品", contextId: null },
    { id: "biz_1", kind: "business", name: "予約" },
    { id: "buc_1", kind: "buc", name: "予約", businessId: "biz_1", isDefault: true },
    { id: "act_1", kind: "activity", name: "探す", bucId: "buc_1" },
    { id: "uc_1", kind: "usecase", name: "検索する" },
  ] as UntieModel["elements"];
  const rel = (kind: string, sourceId: string, targetId: string) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId });
  m0.relations = [rel("activityUsecase", "act_1", "uc_1"), rel("usecaseScreen", "uc_1", "scr_1"), rel("usecaseInformation", "uc_1", "info_1")] as UntieModel["relations"];
  let m = okModel(
    addDesignScreens(m0, {
      systemId: "sys_a",
      screens: [
        { id: "d1", source: { kind: "screen", screenId: "scr_1" } },
        { id: "d_top", source: { kind: "builtin", builtin: "top" } },
      ],
      transitions: [],
    }),
  );
  m = okModel(addTransition(m, { systemId: "sys_a", from: "d1", to: "d_top", via: "button", label: "戻る" }));
  m = okModel(addDatabase(m, { id: "db_x", name: "予約DB" }));
  m = okModel(setDesignDatabases(m, { systemId: "sys_a", databaseIds: ["db_x"] }));
  return okModel(setDatabaseDesign(m, { id: "db_x", dsl: DSL, tables: [{ table: "Item", informationIds: ["info_1"] }] }));
}

const GOOD = {
  view: {
    title: "なんでも",
    goal: "探す",
    sections: [
      { id: "cond", title: "条件", kind: "form", fields: [{ item: "keyword", label: "名前", component: "text" }] },
      { id: "res", title: "結果", kind: "list", list: { columns: [{ id: "name", label: "名前", to: "d_top" }] } },
    ],
  },
  bindings: [
    { item: "keyword", databaseId: "db_x", table: "Item", column: "name" },
    { item: "res.name", databaseId: "db_x", table: "Item", column: "name" },
  ],
};
const opts = { provider: "claude" as const, model: "m", apiKey: "k" };

beforeEach(() => {
  fake.tool = [];
  fake.results = [];
  fake.texts = [];
  fake.sent = [];
});

describe("screenRequest / screenSystemPrompt", () => {
  it("使う操作に、情報を書く (command) か読むだけ (query) かを添える。コマンドに意図の名前があれば、それも渡す", () => {
    // 扱う情報の取得・保存の区別を省くと、読み書きの両方 (command)
    const m = setup();
    expect(screenRequest(m, "sys_a", m.designs[0]!, m.designs[0]!.screens[0]!)).toContain('"kind": "command"');
    const readOnly = { ...m, relations: m.relations.map((r) => (r.kind === "usecaseInformation" ? { ...r, access: "read" as const } : r)) };
    expect(screenRequest(readOnly, "sys_a", readOnly.designs[0]!, readOnly.designs[0]!.screens[0]!)).toContain('"kind": "query"');
    expect(screenSystemPrompt()).toContain("query (情報を読むだけの操作) は、検索条件の form と結果の list");
    // ネットショップ: 出荷を記録する は、ドメインモデルで「出荷する」に決めてある
    const shop = createNetshopSample();
    const screen = shop.elements.find((e) => e.kind === "screen" && shop.relations.some((r) => r.kind === "usecaseScreen" && r.sourceId === "uc_record_shipment" && r.targetId === e.id))!;
    const withDesign = okModel(addDesignScreens(shop, { systemId: "sys_oms", screens: [{ id: "d_ship", source: { kind: "screen", screenId: screen.id } }], transitions: [] }));
    const design = withDesign.designs.find((d) => d.systemId === "sys_oms")!;
    const text = screenRequest(withDesign, "sys_oms", design, design.screens.find((x) => x.id === "d_ship")!);
    expect(text).toContain('"usecase": "出荷を記録する"');
    expect(text).toContain('"command": "出荷する"');
  });

  it("画面・使う DB のテーブルと列 (情報との対応つき)・この画面からの遷移・ナビの有無を渡す", () => {
    const m = setup();
    const text = screenRequest(m, "sys_a", m.designs[0]!, m.designs[0]!.screens[0]!);
    expect(text).toContain("画面「予約検索」");
    expect(text).toContain("予約を探す");
    expect(text).toContain('"usecase": "検索する"');
    expect(text).toContain('"table": "Item"');
    expect(text).toContain('"商品"');
    // 他のテーブルへの関連の列は渡さない
    expect(text).not.toContain('"name": "sale"');
    expect(text).toContain('"toName": "トップページ"');
    expect(text).toContain("ナビゲーション (メニュー): なし");
  });

  it("mokkun v2 の形式の要点を渡す", () => {
    const p = screenSystemPrompt();
    for (const word of ["form|list|readonly|summary", "navigate", "photo_grid", "submit_screen", "bindings"]) expect(p).toContain(word);
  });
});

describe("readScreenProposal / sanitizeBindings", () => {
  it("view がオブジェクトでなければ null。bindings の形の違うものは読み飛ばす", () => {
    expect(readScreenProposal(null)).toBeNull();
    expect(readScreenProposal({ view: [] })).toBeNull();
    expect(readScreenProposal({ view: {}, bindings: [1, { item: "a" }, { item: "a", table: "T", column: "c" }] })).toEqual({ view: {}, bindings: [{ item: "a", table: "T", column: "c" }] });
  });

  it("存在しないデータベース・テーブル・列、view に無い項目、重複を捨てる。databaseId が無くても使う DB が 1 つなら補う", () => {
    const m = setup();
    const { bindings, dropped } = sanitizeBindings(m, m.designs[0]!, GOOD.view, [
      { item: "keyword", table: "Item", column: "name" },
      { item: "keyword", databaseId: "db_x", table: "Item", column: "price" },
      { item: "res.name", databaseId: "db_none", table: "Item", column: "name" },
      { item: "res.name", databaseId: "db_x", table: "Nope", column: "name" },
      { item: "res.name", databaseId: "db_x", table: "Item", column: "nope" },
      { item: "ghost", databaseId: "db_x", table: "Item", column: "name" },
    ]);
    expect(bindings).toEqual([{ item: "keyword", databaseId: "db_x", table: "Item", column: "name" }]);
    expect(dropped).toBe(5);
  });
});

describe("generateScreen", () => {
  it("view の title を画面の名前にして返し、結果の対応は有効なものだけ残す", async () => {
    fake.tool = [{ ...GOOD, bindings: [...GOOD.bindings, { item: "res.name", databaseId: "db_x", table: "Item", column: "ghost" }] }];
    const r = await generateScreen(setup(), "sys_a", "d1", opts);
    expect(r.view.title).toBe("予約検索");
    expect(r.bindings).toHaveLength(2);
    expect(r.dropped).toBe(1);
    expect(fake.results.map((x) => x.ok)).toEqual([true]);
  });

  it("mokkun の検証に通らなければ 1 回だけ出し直させる (理由を返す)。2 回目が通れば採用する", async () => {
    fake.tool = [{ view: { title: "x", goal: "g", sections: [{ id: "a", title: "A", kind: "bogus" }] }, bindings: [] }, GOOD];
    const r = await generateScreen(setup(), "sys_a", "d1", opts);
    expect(fake.results.map((x) => x.ok)).toEqual([false, true]);
    expect(JSON.parse(fake.results[0]!.content).error).toContain("mokkun の検証に通りません");
    expect(r.view.sections).toHaveLength(2);
  });

  it("出し直しても通らなければ失敗 (ChatError)", async () => {
    const bad = { view: { title: "x", goal: "g", sections: [{ id: "a", title: "A", kind: "bogus" }] }, bindings: [] };
    fake.tool = [bad, bad];
    await expect(generateScreen(setup(), "sys_a", "d1", opts)).rejects.toThrow(/検証に通りませんでした/);
    expect(fake.results.map((x) => x.ok)).toEqual([false, false]);
  });

  it("設計に無い画面への to は検証で弾く。文章で JSON を返したときも読む", async () => {
    fake.tool = [{ ...GOOD, view: { ...GOOD.view, secondaryActions: [{ id: "go", label: "どこか", kind: "navigate", to: "ghost" }] } }];
    fake.texts = ["```json\n" + JSON.stringify(GOOD) + "\n```"];
    // 1 回目の道具は 1 回目の検証で弾かれ、道具の結果が ok でないまま send が終わる → 文章は読まず、出し直しの 2 回目を待つ
    await expect(generateScreen(setup(), "sys_a", "d1", opts)).rejects.toThrow(/Unknown view|検証に通りませんでした/);
    fake.results = [];
    fake.tool = [];
    fake.texts = ["```json\n" + JSON.stringify(GOOD) + "\n```"];
    const r = await generateScreen(setup(), "sys_a", "d1", opts);
    expect(r.view.sections).toHaveLength(2);
  });

  it("何も提出しなければ、提出を促してから失敗する", async () => {
    await expect(generateScreen(setup(), "sys_a", "d1", opts)).rejects.toThrow(/提出しませんでした/);
    expect(fake.sent).toHaveLength(2);
    await expect(generateScreen(setup(), "sys_a", "nope", opts)).rejects.toThrow(/見つかりません/);
  });
});
