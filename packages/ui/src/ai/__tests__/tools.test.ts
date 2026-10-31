import { describe, expect, it } from "vitest";
import { okModel, sample } from "@untie/core/testing";
import type { CommandResult } from "@untie/core/model/commands";
import type { UntieModel } from "@untie/core/model/types";
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
});
