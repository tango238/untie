// 段階 1 (データ) を、実物の sqlImport (SQL → DSL の機械的な変換) で通す。フィクスチャのバックエンドの db/schema.sql が、
// 画面の項目の対応 (段階 2 の画面 UI) が結ぶ列を持つ DSL になることを確かめる (偽物を使う reverseStages.test.ts は、段階の流れだけを見る)
import { describe, expect, it } from "vitest";
import { checkDesign } from "@untie/core/model/designCheck";
import { emptyModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { applyScreenDraft } from "../designDraft";
import { applyScreensDraft } from "../reverseScreens";
import { applyDataImport, canImportPreview, defaultSchemaSelection, findSchemaCandidates, previewSchema } from "../reverseData";
import { MULTI_SCREENS, MULTI_SCREENS_STRUCTURE, multiFixtureSources } from "./fixtures/reverseMultiSource";

describe("段階 1: 実物の sqlImport", () => {
  it("バックエンドの db/schema.sql が候補に出て、既定で選ばれ、変換でき、取り込んだデータベースに画面の項目を結べる", async () => {
    const back = multiFixtureSources().find((s) => s.label === "バックエンド")!;
    const { candidates } = await findSchemaCandidates(back.tree);
    expect(candidates.map((c) => [c.path, c.hasTables])).toEqual([["db/schema.sql", true]]);
    const withId = candidates.map((c) => ({ ...c, id: c.path }));
    expect([...defaultSchemaSelection(withId)]).toEqual(["db/schema.sql"]);
    const preview = previewSchema([{ path: "バックエンド/db/schema.sql", kind: "sql", text: await candidates[0]!.read() }]);
    expect(canImportPreview(preview)).toBe(true);
    expect(preview.tables.map((t) => t.name).sort()).toEqual(["Order", "OrderItem", "Product"]);
    expect(preview.dslErrors).toEqual([]);

    const imported = applyDataImport(emptyModel("m"), { name: "バックエンドのデータベース", dsl: preview.dsl });
    expect(imported.failure).toBeUndefined();
    const structured = applyScreensDraft(imported.model, MULTI_SCREENS_STRUCTURE);
    let model = structured.model;
    expect(model.designs.every((d) => d.databaseIds[0] === imported.databaseId)).toBe(true);
    for (const draft of MULTI_SCREENS) {
      const sysName = MULTI_SCREENS_STRUCTURE.systems.find((s) => s.screens.some((x) => x.name === draft.screen))!.name;
      const r = applyScreenDraft(model, { ...draft, system: sysName });
      expect(r.applied, `${draft.screen}: ${r.warnings.join(" / ")}`).toBe(true);
      expect(r.added.droppedBindings).toBe(0);
      model = r.model;
    }
    expect(validateModel(JSON.parse(JSON.stringify(model))).ok).toBe(true);
    for (const d of model.designs) expect(checkDesign(model, d.systemId).problems).toEqual([]);
  });
});
