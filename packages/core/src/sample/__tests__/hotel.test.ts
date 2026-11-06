import { describe, expect, it } from "vitest";
import { createHotelSample, hotelSample } from "..";
import { traceToActors, traceWarnings } from "../../model/trace";
import { checkIntegrity, DEFAULT_CARD_SIZE, DEFAULT_FRAME_SIZE, RELATION_KINDS, validateModel } from "../../model";
import type { BoardNode } from "../../model";

describe("宿泊施設サンプル", () => {
  it("スキーマ検証と参照整合性検査を通る", () => {
    const r = validateModel(JSON.parse(JSON.stringify(hotelSample)));
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(checkIntegrity(hotelSample)).toEqual([]);
  });

  it("すべての要素が担い手まで辿れて、イベントの連鎖のほかに警告が出ない", () => {
    expect(traceToActors(hotelSample).problems.map((p) => `${p.elementId}: ${p.reason}`)).toEqual([]);
    // 1 つの業務に付くアクターは主担当の 1 人 (警告も出ない)。イベントで終わらない連鎖の警告は、見本のネットショップ以外では残す
    expect(
      traceWarnings(hotelSample)
        .filter((w) => w.type !== "chainEnd")
        .map((w) => `${w.elementId}: ${w.reason}`),
    ).toEqual([]);
  });

  it("設計書 7 章の件数どおり", () => {
    const count = (kind: string) => hotelSample.elements.filter((e) => e.kind === kind).length;
    expect(count("business")).toBe(5);
    expect(count("actor")).toBe(4);
    expect(count("externalActor")).toBe(2);
    expect(count("system")).toBe(4);
    expect(count("ledger")).toBe(2);
    expect(count("buc")).toBe(5 + 3);
    expect(count("activity")).toBeGreaterThanOrEqual(15);
    expect(count("usecase")).toBeGreaterThanOrEqual(10);
    expect(count("information")).toBe(6);
    expect(count("state")).toBe(9);
    expect(count("variation")).toBe(3);
    expect(count("condition")).toBe(3);
    expect(count("issue")).toBe(5);
    expect(hotelSample.boards.map((b) => b.name)).toEqual(["全体", "予約からチェックアウトまで", "情報と状態"]);
  });

  it("0.1.0 からある関係の種類と、操作の対象 (usecaseSystem) がすべて使われている (新しい種類は見本のネットショップで使う)", () => {
    const kinds = new Set(hotelSample.relations.map((r) => r.kind));
    const legacy = RELATION_KINDS.slice(0, RELATION_KINDS.indexOf("usecaseState") + 1);
    for (const k of [...legacy, "usecaseSystem"] as const) expect(kinds.has(k), k).toBe(true);
    // システムは作業の担当にならない
    const kindOf = new Map(hotelSample.elements.map((e) => [e.id, e.kind]));
    expect(hotelSample.relations.some((r) => r.kind === "actorActivity" && kindOf.get(r.sourceId) === "system")).toBe(false);
  });

  it("「滞在中の対応」にだけ既定でない活動があり、その業務の作業はすべて活動に入っている", () => {
    const nonDefault = hotelSample.elements.filter((e) => e.kind === "buc" && !e.isDefault);
    expect(nonDefault.every((b) => b.kind === "buc" && b.businessId === "biz_stay")).toBe(true);
    expect(nonDefault).toHaveLength(3);
    // 業務直下と活動を混ぜない
    expect(hotelSample.elements.some((e) => e.kind === "activity" && e.bucId === "buc_default_stay")).toBe(false);
  });

  it("createHotelSample は独立したコピーを返す", () => {
    const a = createHotelSample();
    a.elements.pop();
    expect(createHotelSample().elements.length).toBe(hotelSample.elements.length);
  });

  it("「全体」ボードで子のカードと小枠が親の枠に収まる", () => {
    const board = hotelSample.boards.find((b) => b.id === "board_overview")!;
    const node = (id: string) => board.nodes.find((n) => n.elementId === id);
    const rect = (n: BoardNode) => {
      const el = hotelSample.elements.find((e) => e.id === n.elementId)!;
      const size = el.kind === "business" || el.kind === "buc" ? DEFAULT_FRAME_SIZE[el.kind] : DEFAULT_CARD_SIZE;
      return { x: n.x, y: n.y, w: n.width ?? size.width, h: n.height ?? size.height };
    };
    let checked = 0;
    for (const n of board.nodes) {
      const el = hotelSample.elements.find((e) => e.id === n.elementId)!;
      let parentId: string | null = null;
      if (el.kind === "buc" && !el.isDefault) parentId = el.businessId;
      if (el.kind === "activity" && el.bucId) {
        const buc = hotelSample.elements.find((e) => e.id === el.bucId);
        if (buc?.kind === "buc") parentId = !buc.isDefault && node(buc.id) ? buc.id : buc.businessId;
      }
      const parent = parentId ? node(parentId) : undefined;
      if (!parent) continue;
      const c = rect(n);
      const p = rect(parent);
      expect(c.x, `${el.id} の左`).toBeGreaterThanOrEqual(p.x);
      expect(c.y, `${el.id} の上`).toBeGreaterThanOrEqual(p.y);
      expect(c.x + c.w, `${el.id} の右`).toBeLessThanOrEqual(p.x + p.w);
      expect(c.y + c.h, `${el.id} の下`).toBeLessThanOrEqual(p.y + p.h);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it("仮予約から確定へ遷移する操作がある", () => {
    const rels = hotelSample.relations;
    const from = rels.filter((r) => r.kind === "stateUsecase" && r.sourceId === "st_res_tentative").map((r) => r.targetId);
    const to = rels.filter((r) => r.kind === "usecaseState" && r.targetId === "st_res_confirmed").map((r) => r.sourceId);
    expect(from.filter((id) => to.includes(id))).not.toHaveLength(0);
  });

  it("「予約からチェックアウトまで」に鍵を渡す作業がある", () => {
    const board = hotelSample.boards.find((b) => b.id === "board_flow")!;
    expect(board.nodes.some((n) => n.elementId === "act_hand_key")).toBe(true);
  });
});
