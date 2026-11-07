import { describe, expect, it } from "vitest";
import { okModel, sample } from "@untie/core/testing";
import type { CommandResult } from "@untie/core/model/commands";
import type { UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { addDatabase, ensureDesign } from "@untie/core/model/commands";
import { executeTool, MODEL_TOOLS, modelForAi, type ModelEditor } from "../tools";

function editorOf(initial: UntieModel): ModelEditor & { model: UntieModel } {
  const e = {
    model: initial,
    getModel: () => e.model,
    apply: <T,>(cmd: (m: UntieModel) => CommandResult<T>) => {
      const r = cmd(e.model);
      if (r.ok) e.model = r.model;
      return r;
    },
  };
  return e;
}
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("AI の道具", () => {
  it("道具の名前はすべて executeTool で扱える", () => {
    const e = editorOf(sample());
    for (const t of MODEL_TOOLS) expect(String(parse(executeTool(e, t.name, {}).content).error ?? "")).not.toMatch(/不明な道具/);
    expect(executeTool(e, "nope", {}).ok).toBe(false);
  });

  it("get_model は既定 BUC を隠し、業務に直接属する作業は業務を示す", () => {
    const m = modelForAi(sample()) as { elements: Record<string, unknown>[]; relations: unknown[] };
    expect(m.elements.some((x) => x.kind === "buc" && x.isDefault)).toBe(false);
    expect(m.elements.find((x) => x.id === "act_hand_key")).toMatchObject({ businessId: "biz_checkin" });
    expect(m.elements.find((x) => x.id === "act_room_service")).toMatchObject({ bucId: "buc_dining" });
    expect(m.relations[0]).toHaveLength(3);
  });

  it("作業を業務に直接足し、担当を結び、時間を入れられる", () => {
    const e = editorOf(sample());
    const r = executeTool(e, "add_element", { kind: "activity", name: "セルフチェックインを受け付ける", business_id: "biz_checkin", hours: 0.2 });
    expect(r.ok && r.changed).toBe(true);
    const id = parse(r.content).id as string;
    expect(e.model.elements.find((x) => x.id === id)).toMatchObject({ bucId: "buc_default_checkin", hours: 0.2 });
    expect(executeTool(e, "add_relation", { source_id: "ext_guest", target_id: id }).ok).toBe(true);
    expect(executeTool(e, "remove_relation", { source_id: id, target_id: "ext_guest" }).ok).toBe(true);
  });

  it("長すぎる名前・説明はコマンドの失敗がそのまま返り、要素もモデルも変わらない (スキーマに合わない要素を作らない)", () => {
    const e = editorOf(sample());
    const before = e.model;
    const tooLongName = executeTool(e, "add_element", { kind: "actor", name: "あ".repeat(201) });
    expect(tooLongName).toMatchObject({ ok: false, changed: false });
    expect(parse(tooLongName.content).error).toBe("名前は 200 文字までです");
    const tooLongDescription = executeTool(e, "add_element", { kind: "actor", name: "担当", description: "あ".repeat(4001) });
    expect(parse(tooLongDescription.content).error).toBe("説明は 4000 文字までです");
    const updateName = executeTool(e, "update_element", { id: "actor_front", name: "あ".repeat(201) });
    expect(parse(updateName.content).error).toBe("名前は 200 文字までです");
    const updateDescription = executeTool(e, "update_element", { id: "actor_front", description: "あ".repeat(4001) });
    expect(parse(updateDescription.content).error).toBe("説明は 4000 文字までです");
    const updateValues = executeTool(e, "update_element", { id: "var_room_type", values: ["あ".repeat(201)] });
    expect(updateValues.ok).toBe(false);
    expect(e.model).toBe(before);
    // 上限ちょうどなら通り、できたモデルはスキーマの検証に通る
    expect(executeTool(e, "update_element", { id: "actor_front", description: "あ".repeat(4000) }).ok).toBe(true);
    expect(validateModel(JSON.parse(JSON.stringify(e.model))).ok).toBe(true);
  });

  it("失敗はコマンドの理由を返し、モデルを変えない", () => {
    const e = editorOf(sample());
    const before = e.model;
    const r = executeTool(e, "add_relation", { source_id: "info_room", target_id: "actor_front" });
    expect(r.ok).toBe(false);
    expect(parse(r.content).error).toBeTruthy();
    expect(e.model).toBe(before);
    expect(executeTool(e, "add_element", { kind: "nope", name: "x" }).ok).toBe(false);
    expect(executeTool(e, "update_element", { id: "act_clean", hours: 0.25 }).ok).toBe(false);
  });

  it("所属の変更・時間を消す・リンク・課題の対象・コンテキスト", () => {
    const e = editorOf(sample());
    expect(executeTool(e, "move_activity", { activity_id: "act_hand_key", buc_id: "buc_dining" }).ok).toBe(true);
    expect(executeTool(e, "move_activity", { activity_id: "act_hand_key", business_id: "biz_checkout" }).ok).toBe(true);
    expect(e.model.elements.find((x) => x.id === "act_hand_key")).toMatchObject({ bucId: "buc_default_checkout" });
    expect(executeTool(e, "update_element", { id: "act_clean", hours: null }).ok).toBe(true);
    expect(e.model.elements.find((x) => x.id === "act_clean")).not.toHaveProperty("hours");
    expect(executeTool(e, "update_element", { id: "act_clean", links: [{ title: "手順", url: "https://example.com/c" }] }).ok).toBe(true);
    expect(executeTool(e, "update_element", { id: "issue_manual_entry", target_ids: ["act_clean"] }).ok).toBe(true);
    expect(executeTool(e, "set_context", { element_id: "cond_full" }).ok).toBe(true);
    expect(e.model.elements.find((x) => x.id === "cond_full")).toMatchObject({ contextId: null });
    expect(executeTool(e, "remove_element", { id: "act_clean" }).ok).toBe(true);
    void okModel;
  });

  it("remove_element は確認なしで消すが、一緒に消えた設計データを結果に含める。設計に使われていなければ含めない", () => {
    const e = editorOf(sample());
    expect(parse(executeTool(e, "remove_element", { id: "sys_payment" }).content)).toEqual({ ok: true });
    e.model = okModel(ensureDesign(e.model, { systemId: "sys_pms" }));
    e.model = {
      ...e.model,
      designs: e.model.designs.map((d) => ({ ...d, screens: [{ id: "ds_top", source: { kind: "builtin" as const, builtin: "top" as const } }] })),
    };
    const r = executeTool(e, "remove_element", { id: "sys_pms" });
    expect(r.ok && r.changed).toBe(true);
    expect(parse(r.content).removedDesign).toBe("設計データも一緒に消えました: 「宿泊管理システム」の設計 (画面 1)");
    expect(e.model.designs).toEqual([]);
  });

  it("update_element の trigger_note は作業の起点 (その他) を書き、空文字で消す。作業以外には書けない", () => {
    const e = editorOf(sample());
    expect(executeTool(e, "update_element", { id: "act_clean", trigger_note: "電話" }).ok).toBe(true);
    expect(e.model.elements.find((x) => x.id === "act_clean")).toMatchObject({ triggerNote: "電話" });
    expect(executeTool(e, "update_element", { id: "act_clean", trigger_note: "" }).ok).toBe(true);
    expect("triggerNote" in e.model.elements.find((x) => x.id === "act_clean")!).toBe(false);
    expect(executeTool(e, "update_element", { id: "act_clean", trigger_note: "あ".repeat(4001) }).ok).toBe(false);
    expect(executeTool(e, "update_element", { id: "uc_calc_charge", trigger_note: "電話" }).ok).toBe(false);
    // 起点の関係は add_relation で結べる
    expect(executeTool(e, "add_relation", { source_id: "act_hand_key", target_id: "act_collect_key" }).ok).toBe(true);
    expect(e.model.relations[e.model.relations.length - 1]!.kind).toBe("activityTrigger");
  });
});

describe("AI の道具: データベース", () => {
  const withDb = () => {
    const e = editorOf(sample());
    expect(parse(executeTool(e, "set_database_dsl", { database_id: "db_none", dsl: "" }).content).error).toMatch(/存在しません/);
    e.model = okModel(addDatabase(e.model, { id: "db_x", name: "予約DB" }));
    return e;
  };

  it("set_database_dsl は解析エラーがあっても保存し、結果にエラーを返す", () => {
    const e = withDb();
    const r = executeTool(e, "set_database_dsl", { database_id: "db_x", dsl: "model A {\n  1x Int\n}" });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect((parse(r.content).parseErrors as unknown[]).length).toBe(1);
    expect(parse(r.content).parseErrorCount).toBe(1);
    // 多いときは先頭 20 件と件数
    const many = executeTool(e, "set_database_dsl", { database_id: "db_x", dsl: "model A {\n" + "1x Int\n".repeat(30) + "}" });
    expect((parse(many.content).parseErrors as unknown[]).length).toBe(20);
    expect(parse(many.content).parseErrorCount).toBe(30);
    executeTool(e, "set_database_dsl", { database_id: "db_x", dsl: "model A {\n  1x Int\n}" });
    expect(e.model.databases[0]!.dsl).toBe("model A {\n  1x Int\n}");
    const good = executeTool(e, "set_database_dsl", { database_id: "db_x", dsl: "model A {\n  id String @id\n}" });
    expect(parse(good.content).parseErrors).toEqual([]);
    expect(executeTool(e, "set_database_dsl", { database_id: "db_x" }).ok).toBe(false);
  });

  it("get_database_dsl / list_databases / set_table_information", () => {
    const e = withDb();
    executeTool(e, "set_database_dsl", { database_id: "db_x", dsl: "model Reservation {\n  id String @id\n}" });
    const info = e.model.elements.find((x) => x.kind === "information")!;
    const set = executeTool(e, "set_table_information", { database_id: "db_x", table: "Reservation", information_ids: [info.id] });
    expect(set.ok).toBe(true);
    expect(executeTool(e, "set_table_information", { database_id: "db_x", table: "Reservation", information_ids: ["nope"] }).ok).toBe(false);
    expect(executeTool(e, "set_table_information", { database_id: "db_x", table: "Reservation" }).ok).toBe(false);
    const got = parse(executeTool(e, "get_database_dsl", { database_id: "db_x" }).content);
    expect(got).toMatchObject({ id: "db_x", name: "予約DB", dsl: "model Reservation {\n  id String @id\n}", parseErrors: [] });
    const list = parse(executeTool(e, "list_databases", {}).content) as unknown as { id: string; tables: { table: string; inDsl: boolean; informations: { id: string; name: string }[] }[] }[];
    expect(list[0]!.id).toBe("db_x");
    expect(list[0]!.tables).toEqual([{ table: "Reservation", inDsl: true, informations: [{ id: info.id, name: info.name }] }]);
    expect(executeTool(e, "get_database_dsl", { database_id: "nope" }).ok).toBe(false);
  });
});
