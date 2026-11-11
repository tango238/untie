import { describe, expect, it, vi } from "vitest";
import { addDatabase, setDatabaseDsl, setTableInformation } from "@untie/core/model/commands";
import { createNetshopSample } from "@untie/core/sample";
import { okModel, sample } from "@untie/core/testing";
import type { ChatOptions } from "../chat";

const fake = vi.hoisted(() => ({ texts: [] as string[], tool: [] as unknown[], toolResults: [] as { ok: boolean; content: string }[], sent: [] as string[] }));
vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    createChatSession: (_p: string, o: ChatOptions) => ({
      seed: () => {},
      send: async (text: string) => {
        fake.sent.push(text);
        while (fake.tool.length > 0) {
          const r = await o.runTool("submit_database", fake.tool.shift());
          fake.toolResults.push(r);
          if (r.ok) break;
        }
        return fake.texts.shift() ?? "";
      },
    }),
  };
});

const { dataDesignRequest, dataDesignSystemPrompt, extractJson, generateDatabaseDesign, readDatabaseDesign } = await import("../designData");

const opts = { provider: "claude" as const, model: "m", apiKey: "k" };
function setup() {
  let m = okModel(addDatabase(sample(), { id: "db_x", name: "予約DB" }));
  m = okModel(setDatabaseDsl(m, { id: "db_x", dsl: "model Old { id Int }" }));
  const system = m.elements.find((e) => e.kind === "system")!;
  return { m, systemId: system.id, db: m.databases[0]! };
}

describe("readDatabaseDesign / extractJson", () => {
  it("形の違うものは null。information_ids も読む", () => {
    expect(readDatabaseDesign(null)).toBeNull();
    expect(readDatabaseDesign({ dsl: 1, tables: [] })).toBeNull();
    expect(readDatabaseDesign({ dsl: "", tables: [{ table: "A", information_ids: ["i", 1] }, { table: "" }, null] })).toEqual({ dsl: "", tables: [{ table: "A", informationIds: ["i"] }] });
  });

  it("文章の中の JSON を取り出す", () => {
    expect(extractJson('説明\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('前置き {"a":2} 後ろ')).toEqual({ a: 2 });
    expect(extractJson("JSON ではない")).toBeNull();
  });
});

describe("generateDatabaseDesign", () => {
  it("依頼に、システムが使う情報・今の DSL・今の対応を入れる", () => {
    const { m, systemId, db } = setup();
    const text = dataDesignRequest(m, systemId, db);
    expect(text).toContain("model Old { id Int }");
    expect(text).toContain("<システムが使う情報>");
  });

  it("集約が決まっている情報には、集約 (名前・英語名・コンテキスト・ルートか中の情報か) を添え、指示に集約の境界の決まりを入れる", () => {
    const m = okModel(addDatabase(createNetshopSample(), { id: "db_s", name: "販売" }));
    const text = dataDesignRequest(m, "sys_oms", m.databases.find((d) => d.id === "db_s")!);
    const infos = JSON.parse(text.slice(text.indexOf("<システムが使う情報>") + "<システムが使う情報>".length, text.indexOf("</システムが使う情報>"))) as { id: string; aggregate?: unknown }[];
    expect(infos.find((i) => i.id === "info_order")!.aggregate).toEqual({ name: "注文", english: "Order", context: "受注", role: "root", rootInformationId: "info_order" });
    // 集約にしていない情報 (購入者) には付かない
    expect(infos.find((i) => i.id === "info_customer")!.aggregate).toBeUndefined();
    expect(dataDesignSystemPrompt()).toContain("別の集約の情報との関連は、@relation を張らずに ID の列だけにする");
  });

  it("文章で返された JSON も読み、存在しない情報とテーブルの対応は捨てる", async () => {
    const { m, systemId, db } = setup();
    fake.texts = ['```json\n{"dsl":"model A {\\n  id String @id\\n}","tables":[{"table":"A","informationIds":["nope"]},{"table":"B","informationIds":[]}]}\n```'];
    fake.tool = [];
    const r = await generateDatabaseDesign(m, systemId, db, opts);
    expect(r.dsl).toContain("model A");
    expect(r.tables).toEqual([]);
    expect(r.dropped).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it("今の DSL が読めるのにエラーが 2 回続いたら、置かずに失敗する。今の DSL が壊れていれば残ったまま返す", async () => {
    const { m, systemId, db } = setup();
    fake.tool = [{ dsl: "model A {\n 1x Int\n}", tables: [] }, { dsl: "model A {\n 1x Int\n}", tables: [] }];
    fake.toolResults = [];
    await expect(generateDatabaseDesign(m, systemId, db, opts)).rejects.toThrow(/置き換えませんでした/);
    expect(fake.toolResults.map((x) => x.ok)).toEqual([false, true]);
    fake.tool = [{ dsl: "model A {\n 1x Int\n}", tables: [] }, { dsl: "model A {\n 1x Int\n}", tables: [] }];
    const broken = { ...db, dsl: "こわれ" };
    const r = await generateDatabaseDesign(m, systemId, broken, opts);
    expect(r.errors).toHaveLength(1);
  });

  it("返ってこなかった既存の対応は、model が残っていれば残す", async () => {
    let { m, systemId, db } = setup();
    const infos = m.elements.filter((e) => e.kind === "information").slice(0, 2).map((e) => e.id);
    m = okModel(setTableInformation(m, { id: "db_x", table: "Old", informationIds: [infos[0]!] }));
    m = okModel(setTableInformation(m, { id: "db_x", table: "Gone", informationIds: [infos[1]!] }));
    db = m.databases[0]!;
    fake.tool = [{ dsl: "model Old { id Int }\nmodel New { id Int }", tables: [{ table: "New", informationIds: [infos[1]!] }] }];
    const r = await generateDatabaseDesign(m, systemId, db, opts);
    expect(r.tables).toEqual([{ table: "New", informationIds: [infos[1]] }, { table: "Old", informationIds: [infos[0]] }]);
  });

  it("何も提出されなければ失敗する", async () => {
    const { m, systemId, db } = setup();
    fake.tool = [];
    fake.texts = ["", ""];
    await expect(generateDatabaseDesign(m, systemId, db, opts)).rejects.toThrow(/提出しませんでした/);
  });
});
