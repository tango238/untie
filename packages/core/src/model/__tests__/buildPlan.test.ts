import { describe, expect, it } from "vitest";
import { createHotelSample, createNetshopSample, SAMPLES } from "../../sample";
import { acceptanceCasesFileName, deriveAcceptanceCases } from "../acceptance";
import { BUILD_DESIGN_FILE, planBuild } from "../buildPlan";
import { ensureDesign, setDatabaseDesign } from "../commands";
import { DEFAULT_DATABASE_ID } from "../design";
import { exportDesignBrief } from "../designBrief";
import { exportSouther } from "../southerExport";
import { emptyModel, type Element, type Relation, type UntieModel } from "../types";
import { okModel } from "./helpers";

/** 準備がすべてそろう、最小のモデル (状態も条件も無い) */
function ready(): UntieModel {
  const m = emptyModel();
  m.elements = [
    { id: "ctx", kind: "context", name: "受付" },
    { id: "actor", kind: "actor", name: "受付係" },
    { id: "sys", kind: "system", name: "受付システム" },
    { id: "biz", kind: "business", name: "受付" },
    { id: "buc", kind: "buc", name: "受付", businessId: "biz", isDefault: true },
    { id: "act", kind: "activity", name: "申し込みを受ける", bucId: "buc" },
    { id: "uc", kind: "usecase", name: "申し込みを登録する" },
    { id: "info", kind: "information", name: "申し込み", contextId: "ctx" },
  ] as Element[];
  const pairs: [Relation["kind"], string, string][] = [
    ["actorBusiness", "actor", "biz"],
    ["actorActivity", "actor", "act"],
    ["activityUsecase", "act", "uc"],
    ["usecaseSystem", "uc", "sys"],
    ["usecaseInformation", "uc", "info"],
  ];
  m.relations = pairs.map(([kind, sourceId, targetId], i) => ({ id: `rel_${i}`, kind, sourceId, targetId }));
  const withDesign = okModel(ensureDesign(m, { systemId: "sys" }));
  return okModel(setDatabaseDesign(withDesign, { id: DEFAULT_DATABASE_ID, dsl: 'model Application {\n  id String @id\n  name String\n  @@map("申し込み")\n}\n', tables: [{ table: "Application", informationIds: ["info"] }] }));
}

describe("planBuild: 実装を始めるときに渡すものを、まとめて組み立てる", () => {
  it("設計書・業務ルール・受け入れテスト・土台を、同じモデルから作る", () => {
    const m = createHotelSample();
    const plan = planBuild(m, "sys_pms");
    expect(plan.system).toBe("宿泊管理システム");
    expect(plan.files.map((f) => f.path)).toEqual([
      "design/design.md",
      "design/sys_pms.sou",
      "acceptance/sys_pms.cases.json",
      "acceptance/run.test.ts",
      "acceptance/README.md",
      "package.json",
    ]);
    const file = (path: string) => plan.files.find((f) => f.path === path)!.text;
    expect(file(BUILD_DESIGN_FILE)).toBe(exportDesignBrief(m, "sys_pms").text);
    expect(file("design/sys_pms.sou")).toBe(exportSouther(m, "sys_pms").text);
    expect(JSON.parse(file(`acceptance/${acceptanceCasesFileName("sys_pms")}`)).cases).toHaveLength(deriveAcceptanceCases(m, "sys_pms").cases.length);
    expect(plan.acceptanceCases).toBe(37);
    // ほかのシステムのケースは入れない
    expect(plan.files.some((f) => f.path.includes("sys_booking_site"))).toBe(false);
    // 土台: モデルを呼ぶためのパッケージと、動かし方・テストの仕方の決まり
    expect(JSON.parse(file("package.json"))).toMatchObject({ name: "pms", type: "module", scripts: { test: 'node --test "app/test/**/*.test.ts"' }, dependencies: { "@souther-lang/wasm": "0.4.1" } });
  });

  it("業務ルールのモデルの置き場所と、書き換えさせないファイルと、完了の検査を決める", () => {
    const plan = planBuild(createHotelSample(), "sys_pms");
    expect(plan.model).toEqual({ source: "design/sys_pms.sou", wasm: "model/pms.wasm", bindings: "model/pms.ts", moduleName: "untie.sys_pms" });
    // 土台 (package.json) のほかは、書き換えさせない。モデルをコンパイルしたものも
    expect(plan.protectedPaths).toEqual(["design/design.md", "design/sys_pms.sou", "model/pms.wasm", "model/pms.ts", "acceptance/sys_pms.cases.json", "acceptance/run.test.ts", "acceptance/README.md"]);
    expect(plan.checks).toEqual([
      { name: "受け入れテスト", command: "node --test acceptance/run.test.ts" },
      { name: "アプリのテスト", command: "npm test" },
    ]);
  });

  it("準備がそろっていなければ ready は false で、残りの数を返す。依頼文は、決まっていないところを作らせない", () => {
    const plan = planBuild(createHotelSample(), "sys_pms");
    expect(plan.ready).toBe(false);
    expect(plan.remaining).toBeGreaterThan(0);
    expect(plan.task).toContain("「まだ決まっていないこと」に挙がっているものは、今回作る範囲の外です");
    expect(plan.operations).toContain("予約を取り消す");
    expect(plan.task).toContain("- 予約を取り消す\n");
    // ほかのシステムの操作は、作るものに入れない
    expect(plan.operations).not.toContain("予約を登録する");
    expect(plan.task).toContain("model/pms.wasm (design/sys_pms.sou を Souther でコンパイルしたもの)");
    expect(plan.task).toContain("node --test acceptance/run.test.ts\nnpm test");
  });

  it("準備がそろっていれば ready は true。状態も条件も無いシステムでは、業務ルールと受け入れテストを付けない", () => {
    const plan = planBuild(ready(), "sys");
    expect(plan.ready).toBe(true);
    expect(plan.remaining).toBe(0);
    expect(plan.files.map((f) => f.path)).toEqual(["design/design.md", "package.json"]);
    expect(plan.model).toBeNull();
    expect(plan.acceptanceCases).toBe(0);
    expect(plan.checks).toEqual([{ name: "アプリのテスト", command: "npm test" }]);
    expect(plan.task).not.toContain("まだ決まっていないこと");
    expect(plan.task).not.toContain("Souther");
    expect(plan.task).not.toContain("driver.ts");
    expect(JSON.parse(plan.files.find((f) => f.path === "package.json")!.text).dependencies).toEqual({});
  });

  it("どのサンプルのどのシステムでも組み立てられる (操作の無いシステム・無いシステムでも落ちない)", () => {
    for (const sample of SAMPLES) {
      const m = sample.create();
      for (const s of m.elements.filter((e) => e.kind === "system")) {
        const plan = planBuild(m, s.id);
        expect(plan.files[0]!.path).toBe("design/design.md");
        expect(new Set(plan.files.map((f) => f.path)).size).toBe(plan.files.length);
      }
    }
    expect(planBuild(createNetshopSample(), "sys_none").ready).toBe(false);
  });
});
