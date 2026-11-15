// 「ソースコードから作成」の段階式 (データ → 画面 → 業務)。AI の会話は偽物にして、段階ごとの関数を台本どおりに動かし、
// 順を変えた組み合わせ・やり直し・失敗・中断・履歴 (Undo) を、開いているモデルに足す形で確かめる。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDesign } from "@untie/core/model/designCheck";
import { emptyModel } from "@untie/core/model/types";
import { traceToActors, traceWarnings } from "@untie/core/model/trace";
import type { UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { updateElement } from "@untie/core/model/commands";
import { resetStore } from "../../test/utils";
import { useUntieStore } from "../../store";
import type { ChatEvents, ChatOptions } from "../chat";
import { commitStageModel } from "../reverseCommit";
import { applyDataImport, previewSchema, type SchemaInput } from "../reverseData";
import type { ModelSpec } from "../spec";
import type { ToolOutcome } from "../tools";
import { FIXTURE_DSL } from "./fixtures/reverseDraft";
import {
  MULTI_DATABASE,
  MULTI_SCHEMA_SQL,
  MULTI_SCREENS,
  MULTI_SCREENS_STRUCTURE,
  MULTI_SHOP,
  MULTI_SPEC,
  MULTI_SPEC_RETURN,
  multiFixtureSources,
} from "./fixtures/reverseMultiSource";

// sqlImport は別の担当が実装している。ここでは、SQL に CREATE TABLE があれば FIXTURE_DSL を返す偽物にして、段階の流れだけを確かめる
vi.mock("@untie/core/model/sqlImport", () => ({
  sqlFilesToPrismaDsl: (files: { path: string; text: string }[]) => {
    const has = files.some((f) => /CREATE TABLE/i.test(f.text));
    return {
      dsl: has ? FIXTURE_DSL : "",
      tables: has ? [{ table: "Order", model: "Order", columns: 4 }, { table: "OrderItem", model: "OrderItem", columns: 5 }, { table: "Product", model: "Product", columns: 3 }] : [],
      enums: [],
      notes: has ? [{ file: files[0]!.path, line: 1, message: "COMMENT ON の文を読み飛ばしました" }] : [],
      dslErrors: [],
    };
  },
  sqlToPrismaDsl: () => ({ dsl: "", tables: [], enums: [], notes: [], dslErrors: [] }),
}));

type Kind = "survey" | "structure" | "model" | "tables" | "screen";
interface Call {
  kind: Kind;
  text: string;
  runTool: ChatOptions["runTool"];
  events?: ChatEvents;
  system: string;
}
type Script = (c: Call) => Promise<string> | string;

const fake = vi.hoisted(() => ({
  scripts: {} as Partial<Record<string, (c: unknown) => Promise<string> | string>>,
  calls: [] as { kind: string; text: string; system: string }[],
}));

vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as { MAX_STEPS: number };
  return {
    ...actual,
    createChatSession: (_provider: string, o: ChatOptions) => {
      const names = o.tools.map((t) => t.name);
      const kind = names.includes("submit_screens") ? "structure" : names.includes("submit_model") ? "model" : names.includes("use_database") ? "tables" : names.includes("submit_screen") ? "screen" : "survey";
      return {
        seed: () => {},
        send: async (text: string, events?: ChatEvents) => {
          const runTool: ChatOptions["runTool"] = async (name, input) => {
            const outcome = await o.runTool(name, input);
            events?.onTool?.(name, outcome);
            return outcome;
          };
          fake.calls.push({ kind, text, system: o.system });
          return (await fake.scripts[kind]!({ kind, text, runTool, events, system: o.system })) as string;
        },
      };
    },
  };
});

const { reverseScreens } = await import("../reverseScreens");
const { reverseLogic, reverseMapping, mappingGap } = await import("../reverseLogic");
const { REVERSE_LIMITS } = await import("../reverse");

const parse = (r: ToolOutcome) => JSON.parse(r.content) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const screenNameOf = (text: string) => /画面「(.+?)」の画面 UI を作ってください/.exec(text)?.[1] ?? "";
const systemNameOf = (text: string) => /システム「(.+?)」が使う情報と/.exec(text)?.[1] ?? "";

const results: Record<string, ToolOutcome[]> = {};
const keep = (k: string, r: ToolOutcome) => {
  (results[k] ??= []).push(r);
  return r;
};

const surveyScript: Script = async (c) => {
  keep("env", await c.runTool("read_file", { path: "バックエンド/.env" }));
  keep("read", await c.runTool("read_file", { path: "フロント画面/src/pages/OrderNew.tsx" }));
  const text = "## 調査結果\n- 注文入力 (フロント画面/src/pages/OrderNew.tsx)";
  c.events?.onText?.(text);
  return text;
};
const structureScript: Script = async (c) => {
  const r = await c.runTool("submit_screens", MULTI_SCREENS_STRUCTURE);
  return r.ok ? "提出しました" : "直します";
};
const screenScript: Script = async (c) => {
  const draft = MULTI_SCREENS.find((d) => d.screen === screenNameOf(c.text));
  if (draft) await c.runTool("submit_screen", draft);
  return "提出しました";
};
let nextSpec: ModelSpec = MULTI_SPEC;
const modelScript: Script = async (c) => {
  const r = await c.runTool("submit_model", nextSpec);
  return r.ok ? "提出しました" : "直します";
};
const tablesScript: Script = async (c) => {
  await c.runTool("use_database", { system: systemNameOf(c.text), database: "バックエンドのデータベース", tables: MULTI_DATABASE.tables });
  return "提出しました";
};

function useScripts(over: Partial<Record<Kind, Script>> = {}) {
  fake.calls.length = 0;
  for (const k of Object.keys(results)) delete results[k];
  nextSpec = MULTI_SPEC;
  fake.scripts = { survey: surveyScript, structure: structureScript, model: modelScript, tables: tablesScript, screen: screenScript, ...over } as typeof fake.scripts;
}

const baseOptions = { provider: "claude" as const, model: "claude-opus-5-5", apiKey: "k" };
const callsOf = (kind: Kind) => fake.calls.filter((c) => c.kind === kind);

/** 段階 1: SQL を変換して、モデルにデータベースを足す (ソースの db/schema.sql) */
function runData(model: UntieModel, name = "バックエンドのデータベース"): UntieModel {
  const inputs: SchemaInput[] = [{ path: "バックエンド/db/schema.sql", kind: "sql", text: MULTI_SCHEMA_SQL }];
  const preview = previewSchema(inputs);
  const r = applyDataImport(model, { name, dsl: preview.dsl });
  expect(r.failure).toBeUndefined();
  return r.model;
}
const runScreens = async (model: UntieModel, over: Partial<Parameters<typeof reverseScreens>[2]> = {}) => (await reverseScreens(model, multiFixtureSources(), { ...baseOptions, ...over })).model;
const runLogic = async (model: UntieModel, request = "お客様の注文から、スタッフの承認まで") => (await reverseLogic(model, multiFixtureSources(), request, baseOptions)).model;

/** どの状態でも守ること: 検証に通り、担い手まで辿れ、画面は 1 つの操作だけが使う */
function expectHealthy(model: UntieModel) {
  const v = validateModel(JSON.parse(JSON.stringify(model)));
  expect(v.ok ? [] : v.errors).toEqual([]);
  const trace = traceToActors(model);
  expect(trace.problems.filter((p) => p.isBreak).map((p) => `${p.elementId}: ${p.reason}`)).toEqual([]);
  expect(trace.errors).toEqual([]);
}
const count = (model: UntieModel, kind: string) => model.elements.filter((e) => e.kind === kind).length;
const design = (model: UntieModel, system: string) => model.designs.find((d) => d.systemId === model.elements.find((e) => e.kind === "system" && e.name === system)?.id);

const fresh = () => emptyModel("テストのモデル");

beforeEach(() => {
  useScripts();
});

describe("段階 1 → 2 → 3 の順", () => {
  it("最終のモデルが検証に通り、画面の項目は段階 1 のテーブルの列に結ばれ、テーブルと情報の対応が付く", async () => {
    let m = runData(fresh());
    expect(m.databases.map((d) => d.name)).toEqual(["バックエンドのデータベース"]);
    expect(m.designs).toEqual([]);
    expectHealthy(m);
    m = await runScreens(m);
    expectHealthy(m);
    expect(count(m, "system")).toBe(2);
    expect(count(m, "screen")).toBe(4);
    expect(count(m, "business")).toBe(0);
    m = await runLogic(m);
    expectHealthy(m);
    expect(traceWarnings(m)).toEqual([]);
    for (const d of m.designs) expect(checkDesign(m, d.systemId).problems).toEqual([]);
    // 項目は、段階 1 のデータベースのテーブルの列に結ばれている
    const dbId = m.databases[0]!.id;
    const bindings = m.designs.flatMap((d) => d.screens.flatMap((s) => s.bindings ?? []));
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every((b) => b.databaseId === dbId)).toBe(true);
    // テーブルと情報の対応
    const info = (n: string) => m.elements.find((e) => e.kind === "information" && e.name === n)!.id;
    expect(m.databases[0]!.tables.find((t) => t.table === "Order")!.informationIds).toContain(info("注文"));
    // 画面は操作に結ばれている (1 画面 = 1 操作)
    const screens = m.elements.filter((e) => e.kind === "screen");
    for (const s of screens) expect(m.relations.filter((r) => r.kind === "usecaseScreen" && r.targetId === s.id)).toHaveLength(1);
    // 画面の段階は画面の数だけ AI を呼ぶが、業務の段階は、すでにあるシステム・画面を材料にする
    expect(callsOf("screen").map((c) => screenNameOf(c.text)).sort()).toEqual(["承認待ち一覧", "注文の状況", "注文入力", "注文承認"]);
    expect(callsOf("model")[0]!.text).toContain("すでにあるシステムと画面");
    expect(callsOf("model")[0]!.text).toContain("注文入力");
    // 設計 (使うデータベース) はシステムができた段階で結ばれる
    for (const d of m.designs) expect(d.databaseIds).toEqual([dbId]);
  });

  it("秘密のファイルは、どの段階でも AI に読ませない", async () => {
    await runScreens(runData(fresh()));
    const env = parse(results.env![0]!);
    expect(env.error).toBeDefined();
    expect(JSON.stringify(results.env)).not.toContain("NOT-A-REAL-KEY");
  });
});

describe("途中の状態", () => {
  const cases: { name: string; steps: ("1" | "2" | "3")[] }[] = [
    { name: "1 だけ", steps: ["1"] },
    { name: "1 → 2", steps: ["1", "2"] },
    { name: "2 だけ", steps: ["2"] },
    { name: "3 だけ", steps: ["3"] },
    { name: "1 → 3", steps: ["1", "3"] },
    { name: "2 → 3", steps: ["2", "3"] },
    { name: "3 → 2 → 1", steps: ["3", "2", "1"] },
    { name: "2 → 1 → 3", steps: ["2", "1", "3"] },
    { name: "3 → 1 → 2", steps: ["3", "1", "2"] },
  ];
  for (const c of cases) {
    it(`${c.name}: 検証に通り、担い手まで辿れる`, async () => {
      let m = fresh();
      for (const s of c.steps) {
        m = s === "1" ? runData(m) : s === "2" ? await runScreens(m) : await runLogic(m);
        expectHealthy(m);
      }
      // どの状態も、同じ名前の要素が二重にならない
      for (const kind of ["system", "screen", "business", "information"]) {
        const names = m.elements.filter((e) => e.kind === kind).map((e) => (e.kind === "screen" ? `${e.systemId}/${e.name}` : e.name));
        expect(new Set(names).size).toBe(names.length);
      }
      expect(m.databases.filter((d) => d.dsl.trim() !== "").length).toBeLessThanOrEqual(1);
    });
  }

  it("画面だけ (操作に結ばれていない画面) は、モデルの検証と担い手の検証に通り、設計の検証にもエラーは出ない", async () => {
    const m = await runScreens(fresh());
    expectHealthy(m);
    expect(m.relations.some((r) => r.kind === "usecaseScreen")).toBe(false);
    expect(m.designs.flatMap((d) => checkDesign(m, d.systemId).problems)).toEqual([]);
  });

  it("データの段階が、画面の段階のあとでも、既定の空のデータベースを使い、設計がそのデータベースを使う", async () => {
    let m = await runScreens(fresh());
    m = runData(m);
    expect(m.databases).toHaveLength(1);
    expect(m.databases[0]!.name).toBe("バックエンドのデータベース");
    for (const d of m.designs) expect(checkDesign(m, d.systemId).problems).toEqual([]);
  });

  it("業務だけを先に実行すると、画面は業務に関わるものだけが足され、データベースが無いのでテーブルの対応は付けず、案内が出る", async () => {
    const res = await reverseLogic(fresh(), multiFixtureSources(), "お客様の注文から", baseOptions);
    expect(count(res.model, "screen")).toBe(4);
    expect(res.model.designs).toEqual([]);
    expect(res.warnings.some((w) => /データベースがまだ無い/.test(w) && /データの段階/.test(w))).toBe(true);
    expect(callsOf("tables")).toHaveLength(0);
  });
});

describe("やり直し", () => {
  it("同じ段階を 2 回実行しても、システム・画面・データベース・業務が二重にならない", async () => {
    let m = runData(fresh());
    m = await runScreens(m);
    m = await runLogic(m);
    const snapshot = { systems: count(m, "system"), screens: count(m, "screen"), dbs: m.databases.length, business: count(m, "business"), usecases: count(m, "usecase"), relations: m.relations.length, designScreens: m.designs.reduce((n, d) => n + d.screens.length, 0), infos: count(m, "information") };
    const m2 = runData(m);
    const m3 = await runScreens(m2);
    const m4 = await runLogic(m3);
    expect({ systems: count(m4, "system"), screens: count(m4, "screen"), dbs: m4.databases.length, business: count(m4, "business"), usecases: count(m4, "usecase"), relations: m4.relations.length, designScreens: m4.designs.reduce((n, d) => n + d.screens.length, 0), infos: count(m4, "information") }).toEqual(snapshot);
    expectHealthy(m4);
    // 画面の段階のやり直しは、すでにある画面の画面 UI を作り直さない (AI を呼ばない)
    const before = callsOf("screen").length;
    await runScreens(m4);
    expect(callsOf("screen").length).toBe(before);
    // 業務のやり直しは、対応が付いているので、テーブルの対応の会話を開かない
    const tablesBefore = callsOf("tables").length;
    await runLogic(m4);
    expect(callsOf("tables").length).toBe(tablesBefore);
  });

  it("データの段階のやり直しで、無くなった列への画面の対応が外れて知らされ、同じ名前のテーブルの情報との対応は残る", async () => {
    let m = runData(fresh());
    m = await runScreens(m);
    m = await runLogic(m);
    const bindingCount = (x: UntieModel) => x.designs.reduce((n, d) => n + d.screens.reduce((k, s) => k + (s.bindings?.length ?? 0), 0), 0);
    const before = bindingCount(m);
    // Product 表と Order の status 列が無くなった DSL に置き直す
    const dsl = FIXTURE_DSL.replace(/\/\/ 商品\nmodel Product \{[\s\S]*?\n\}\n/, "").replace("  productId String\n  product   Product @relation(fields: [productId], references: [id])\n", "").replace("  status     String\n", "");
    const r = applyDataImport(m, { name: "バックエンドのデータベース", dsl });
    expect(r.failure).toBeUndefined();
    expect(r.replaced).toBe(true);
    expect(r.droppedBindings).toBeGreaterThan(0);
    expect(bindingCount(r.model)).toBe(before - r.droppedBindings);
    expect(r.droppedMappings).toContain("Product");
    expect(r.keptMappings).toBe(2);
    expect(r.model.databases).toHaveLength(1);
    // 同じ名前のテーブルの対応は残る
    expect(r.model.databases[0]!.tables.find((t) => t.table === "Order")!.informationIds.length).toBeGreaterThan(0);
    expectHealthy(r.model);
    for (const d of r.model.designs) expect(checkDesign(r.model, d.systemId).problems.filter((p) => p.type === "bindingInvalid")).toEqual([]);
  });

  it("業務を変えて 2 回目を実行すると、業務が足され、共有の登場人物・情報・画面は二重にならない", async () => {
    let m = runData(fresh());
    m = await runScreens(m);
    m = await runLogic(m);
    const before = { actors: count(m, "actor"), ext: count(m, "externalActor"), systems: count(m, "system"), infoNames: m.elements.filter((e) => e.kind === "information").map((e) => e.name) };
    nextSpec = MULTI_SPEC_RETURN;
    const res = await reverseLogic(m, multiFixtureSources(), "お客様の返品", baseOptions);
    const m2 = res.model;
    expect(m2.elements.filter((e) => e.kind === "business").map((e) => e.name).sort()).toEqual(["ネット注文の受付", "返品の受付"]);
    expect(count(m2, "actor")).toBe(before.actors);
    expect(count(m2, "externalActor")).toBe(before.ext);
    expect(count(m2, "system")).toBe(before.systems);
    expect(m2.elements.filter((e) => e.kind === "information").map((e) => e.name).sort()).toEqual([...before.infoNames, "返品"].sort());
    // 「注文」の説明は、すでにあるので書き換えない
    expect(m2.elements.find((e) => e.kind === "information" && e.name === "注文")!.description).not.toContain("二重にならない");
    // 新しい画面だけが足され、すでにある「注文入力」は 1 つのまま、同じ操作を使っている
    expect(count(m2, "screen")).toBe(5);
    expect(m2.elements.filter((e) => e.kind === "screen" && e.name === "注文入力")).toHaveLength(1);
    expectHealthy(m2);
    // 新しい画面は、すでにあるネットショップの設計 (サイトマップ) に載る。画面 UI はまだ無い
    const shop = design(m2, MULTI_SHOP)!;
    expect(shop.screens).toHaveLength(3);
    expect(shop.screens.filter((s) => s.view === undefined)).toHaveLength(1);
    expect(res.warnings.some((w) => /画面 UI がまだ無い/.test(w))).toBe(true);
    // 新しい情報「返品」は、テーブルに対応していないので、気づいたことに残る
    expect(res.warnings.some((w) => /返品/.test(w) && /テーブル/.test(w))).toBe(true);
  });

  it("同じ業務を 2 回実行しても、課題・イベント・操作が二重にならない", async () => {
    nextSpec = { ...MULTI_SPEC, issues: [{ name: "承認が遅い", description: "夜まで待たされる", targets: ["注文を承認する"] }] };
    const m1 = await runLogic(runData(fresh()));
    const m2 = await runLogic(m1);
    for (const kind of ["issue", "event", "usecase", "activity", "state"]) expect(count(m2, kind)).toBe(count(m1, kind));
    expect(m2.relations.length).toBe(m1.relations.length);
  });

  it("利用者が手で直したもの (画面の名前・テーブルと情報の対応・説明) が、ほかの段階のやり直しで消えない", async () => {
    let m = runData(fresh());
    m = await runScreens(m);
    m = await runLogic(m);
    // 手で直す: 画面の説明・システムの名前でない画面の名前変更はしない (名前を変えると別の画面として足される、という約束なので説明を直す)、テーブルと情報の対応を足す
    const scr = m.elements.find((e) => e.kind === "screen" && e.name === "注文の状況")!;
    const edited = updateElement(m, { id: scr.id, patch: { description: "手で直した説明" } });
    expect(edited.ok).toBe(true);
    m = (edited as { model: UntieModel }).model;
    const productInfo = m.elements.find((e) => e.kind === "information" && e.name === "商品")!.id;
    const dbi = m.databases[0]!;
    m = { ...m, databases: [{ ...dbi, tables: [...dbi.tables.filter((t) => t.table !== "Order"), { table: "Order", informationIds: [...(dbi.tables.find((t) => t.table === "Order")?.informationIds ?? []), productInfo] }] }] };
    const mapped = JSON.stringify(m.databases[0]!.tables.find((t) => t.table === "Order"));
    // ほかの段階をやり直す
    const m2 = await runLogic(await runScreens(runData(m)));
    expect(m2.elements.find((e) => e.id === scr.id)!.description).toBe("手で直した説明");
    expect(JSON.stringify(m2.databases[0]!.tables.find((t) => t.table === "Order"))).toBe(mapped);
  });

  it("画面 UI は、作り直したい画面を選んだときだけ作り直す", async () => {
    let m = runData(fresh());
    m = await runScreens(m);
    const before = callsOf("screen").length;
    const m2 = await runScreens(m, { rebuild: [{ system: MULTI_SHOP, screen: "注文入力" }] });
    expect(callsOf("screen").length).toBe(before + 1);
    expect(callsOf("screen")[callsOf("screen").length - 1]!.text).toContain("注文入力");
    expect(count(m2, "screen")).toBe(count(m, "screen"));
  });
});

describe("データを後から取り込んだとき (3 → 2 → 1)", () => {
  it("どのテーブルにも対応していない情報が残り、対応付けだけの入口 (reverseMapping) で解消する。データベースは設計が使うものだけを対象にする", async () => {
    let m = await runLogic(fresh());
    m = await runScreens(m);
    m = runData(m);
    // 設計はまだ使うデータベースを決めていないので、データの段階のあとは、業務の最後の会話が走らない。情報とテーブルの対応が付いていない
    expect(mappingGap(m).informations).toBeGreaterThan(0);
    expect(mappingGap(m).tables).toBeGreaterThan(0);
    const steps: string[] = [];
    const res = await reverseMapping(m, multiFixtureSources(), { ...baseOptions, onStep: (s) => steps.push(s) });
    expect(steps).toEqual(["tables", "done"]);
    expect(callsOf("tables").length).toBeGreaterThan(0);
    expect(res.mappedInformations).toBeGreaterThan(0);
    expect(mappingGap(res.model).informations).toBeLessThan(mappingGap(m).informations);
    expectHealthy(res.model);
    // 対応づけたシステムの設計は、そのデータベースを使う
    for (const d of res.model.designs) expect(d.databaseIds.length).toBeGreaterThan(0);
    // 渡したモデルは変わらない
    expect(mappingGap(m).informations).toBeGreaterThan(0);
  });
});

describe("失敗・中断・履歴", () => {
  it("画面の段階が中断されたら例外になり、渡したモデルは変わらない", async () => {
    const ctl = new AbortController();
    useScripts({
      survey: async (c) => {
        await c.runTool("read_file", { path: "フロント画面/src/pages/OrderNew.tsx" });
        c.events?.onText?.("調査");
        return "調査";
      },
      structure: async (c) => {
        await c.runTool("submit_screens", MULTI_SCREENS_STRUCTURE);
        ctl.abort();
        return "ok";
      },
    });
    const base = runData(fresh());
    const snapshot = JSON.stringify(base);
    await expect(reverseScreens(base, multiFixtureSources(), { ...baseOptions, signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("業務の段階が、提出なしで終われば例外で、渡したモデルは変わらない", async () => {
    useScripts({ model: () => "提出しません" });
    const base = fresh();
    const snapshot = JSON.stringify(base);
    await expect(runLogic(base)).rejects.toThrow(/提出しませんでした/);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("画面 UI の会話が失敗しても、できた分は残り、残りは気づいたことに出る", async () => {
    const { ChatError } = await import("../chat");
    useScripts({
      screen: async (c) => {
        if (screenNameOf(c.text) === "注文の状況") throw new ChatError("道具を使う回数が上限に達しました。");
        const draft = MULTI_SCREENS.find((d) => d.screen === screenNameOf(c.text));
        if (draft) await c.runTool("submit_screen", draft);
        return "提出しました";
      },
    });
    const res = await reverseScreens(runData(fresh()), multiFixtureSources(), baseOptions);
    expect(res.added.ui).toBe(3);
    expect(res.warnings.some((w) => /注文の状況/.test(w) && /画面 UI/.test(w))).toBe(true);
    expectHealthy(res.model);
  });

  it("段階を 1 件の履歴として反映し、元に戻す (Undo) でまとめて戻る。実行中にモデルが替わっていたら反映しない", async () => {
    resetStore(runData(fresh()));
    const st = () => useUntieStore.getState();
    const base = st().model;
    const res = await reverseScreens(base, multiFixtureSources(), baseOptions);
    expect(commitStageModel(base, res.model, st().docSeq)).toEqual({ ok: true });
    expect(st().model).toBe(res.model);
    expect(st().history.past).toHaveLength(1);
    st().undo();
    expect(st().model).toBe(base);
    // 実行している間に手で直された (base と今のモデルが違う)
    useUntieStore.setState({ model: { ...base, meta: { ...base.meta, name: "手で直した" } } });
    const refused = commitStageModel(base, res.model, st().docSeq);
    expect(refused.ok).toBe(false);
    expect(st().model.meta.name).toBe("手で直した");
    // 別のモデルを開いた (docSeq が替わった) あとも反映しない
    useUntieStore.setState({ model: base });
    expect(commitStageModel(base, res.model, st().docSeq + 1).ok).toBe(false);
  });

  it("データの段階も 1 件の履歴で、Undo で戻る", () => {
    resetStore(fresh());
    const st = () => useUntieStore.getState();
    const base = st().model;
    const next = runData(base);
    expect(commitStageModel(base, next, st().docSeq)).toEqual({ ok: true });
    expect(st().model.databases).toHaveLength(1);
    st().undo();
    expect(st().model).toBe(base);
  });
});

describe("上限と指示", () => {
  it("画面 UI は 1 回に REVERSE_LIMITS.screens 画面まで。超えた分は気づいたことに残り、もう一度実行すると続きを作る", async () => {
    const many = {
      systems: [{ name: MULTI_SHOP, screens: Array.from({ length: REVERSE_LIMITS.screens + 3 }, (_, i) => ({ name: `画面${i + 1}`, description: `説明 ${i + 1}` })) }],
    };
    useScripts({ structure: async (c) => { await c.runTool("submit_screens", many); return "ok"; }, screen: () => "提出しません" });
    const res = await reverseScreens(runData(fresh()), multiFixtureSources(), baseOptions);
    expect(callsOf("screen")).toHaveLength(REVERSE_LIMITS.screens);
    expect(res.warnings.some((w) => /上限 30 件を超えた/.test(w) && /もう一度/.test(w))).toBe(true);
  });

  it("対象の画面の範囲が、調査と構成の依頼に入る。画面の指示は業務・操作を作らせない", async () => {
    await runScreens(fresh(), { scope: "管理画面の注文まわりだけ" });
    expect(callsOf("survey")[0]!.text).toContain("管理画面の注文まわりだけ");
    expect(callsOf("structure")[0]!.text).toContain("管理画面の注文まわりだけ");
    expect(callsOf("survey")[0]!.system).toContain("業務・活動・作業・操作・登場人物・情報は作らない");
  });

  it("業務の依頼に、すでにあるシステム・画面・テーブルと列・業務と情報の名前が入り、すでにある名前を使う指示が付く", async () => {
    let m = runData(fresh());
    m = await runScreens(m);
    await runLogic(m);
    const req = callsOf("model")[0]!.text;
    expect(req).toContain("ネットショップ");
    expect(req).toContain("承認待ち一覧");
    expect(req).toContain("フロント画面/src/pages/OrderNew.tsx");
    expect(req).toContain("OrderItem");
    expect(req).toContain("quantity");
    expect(req).toContain("画面とシステムは、すでにある名前をそのまま使う");
    expect(req).toContain("新しい画面は、ソースにあるのに一覧に無いときだけ足す");
    const survey = callsOf("survey")[0]!.text;
    expect(survey).toContain("すでにあるシステムと画面");
  });
});

describe("利用者に見せる文言", () => {
  it("DDD の言葉 (集約・境界づけられたコンテキスト・ドメインイベント) を出さない", async () => {
    await runLogic(await runScreens(runData(fresh())));
    const all = fake.calls.map((c) => `${c.system}\n${c.text}`).join("\n");
    for (const word of ["集約", "境界づけられたコンテキスト", "ドメインイベント"]) expect(all).not.toContain(word);
  });
});
