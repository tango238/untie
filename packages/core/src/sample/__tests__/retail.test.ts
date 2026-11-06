import { describe, expect, it } from "vitest";
import { createRetailSample, retailSample, SAMPLES } from "..";
import { traceToActors, traceWarnings } from "../../model/trace";
import { checkIntegrity, DEFAULT_CARD_SIZE, DEFAULT_FRAME_SIZE, RELATION_KINDS, validateModel } from "../../model";
import type { BoardNode } from "../../model";

describe("店舗サンプル", () => {
  it("スキーマ検証と参照整合性検査を通る", () => {
    const r = validateModel(JSON.parse(JSON.stringify(retailSample)));
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(checkIntegrity(retailSample)).toEqual([]);
  });

  it("すべての要素が担い手まで辿れて、警告も出ない", () => {
    expect(traceToActors(retailSample).problems.map((p) => `${p.elementId}: ${p.reason}`)).toEqual([]);
    // 1 つの業務に付くアクターは主担当の 1 人 (警告も出ない)
    expect(traceWarnings(retailSample).map((w) => `${w.elementId}: ${w.reason}`)).toEqual([]);
  });

  it("業務・登場人物・課題などの件数", () => {
    const count = (kind: string) => retailSample.elements.filter((e) => e.kind === kind).length;
    expect(count("business")).toBe(7);
    expect(count("actor")).toBe(6);
    expect(count("externalActor")).toBe(2);
    expect(count("system")).toBe(4);
    expect(count("ledger")).toBe(3);
    expect(count("buc")).toBe(7 + 3);
    expect(count("activity")).toBeGreaterThanOrEqual(15);
    expect(count("usecase")).toBeGreaterThanOrEqual(10);
    expect(count("information")).toBe(11);
    expect(count("state")).toBe(11);
    expect(count("variation")).toBe(3);
    expect(count("condition")).toBe(3);
    expect(count("issue")).toBe(5);
    expect(retailSample.boards.map((b) => b.name)).toEqual(["全体", "発注からレジ締め・棚卸まで", "情報と状態"]);
  });

  it("0.1.0 からある関係の種類と、操作の対象 (usecaseSystem) がすべて使われている (新しい種類は見本のネットショップで使う)", () => {
    const kinds = new Set(retailSample.relations.map((r) => r.kind));
    const legacy = RELATION_KINDS.slice(0, RELATION_KINDS.indexOf("usecaseState") + 1);
    for (const k of [...legacy, "usecaseSystem"] as const) expect(kinds.has(k), k).toBe(true);
    // システムは作業の担当にならない
    const kindOf = new Map(retailSample.elements.map((e) => [e.id, e.kind]));
    expect(retailSample.relations.some((r) => r.kind === "actorActivity" && kindOf.get(r.sourceId) === "system")).toBe(false);
  });

  it("「レジ・接客」にだけ既定でない活動があり、その業務の作業はすべて活動に入っている", () => {
    const nonDefault = retailSample.elements.filter((e) => e.kind === "buc" && !e.isDefault);
    expect(nonDefault.every((b) => b.kind === "buc" && b.businessId === "biz_register")).toBe(true);
    expect(nonDefault).toHaveLength(3);
    expect(retailSample.elements.some((e) => e.kind === "activity" && e.bucId === "buc_default_register")).toBe(false);
  });

  it("課題は業務・作業・操作のどれかを指し、いちばん重い課題には 4 つの分析が入っている", () => {
    const ids = new Set(retailSample.elements.map((e) => e.id));
    for (const e of retailSample.elements) {
      if (e.kind !== "issue") continue;
      expect(e.targetIds.length).toBeGreaterThan(0);
      for (const t of e.targetIds) expect(ids.has(t), `${e.id} の対象 ${t}`).toBe(true);
    }
    const top = retailSample.elements.find((e) => e.kind === "issue" && e.severity === 5);
    expect(top?.kind === "issue" && top.analysis ? Object.keys(top.analysis).sort() : []).toEqual(["cause", "impact", "location", "phenomenon"]);
  });

  it("createRetailSample は独立したコピーを返す", () => {
    const a = createRetailSample();
    a.elements.pop();
    expect(createRetailSample().elements.length).toBe(retailSample.elements.length);
  });

  it("「全体」ボードで子のカードと小枠が親の枠に収まる", () => {
    const board = retailSample.boards.find((b) => b.id === "board_overview")!;
    const node = (id: string) => board.nodes.find((n) => n.elementId === id);
    const rect = (n: BoardNode) => {
      const el = retailSample.elements.find((e) => e.id === n.elementId)!;
      const size = el.kind === "business" || el.kind === "buc" ? DEFAULT_FRAME_SIZE[el.kind] : DEFAULT_CARD_SIZE;
      return { x: n.x, y: n.y, w: n.width ?? size.width, h: n.height ?? size.height };
    };
    let checked = 0;
    for (const n of board.nodes) {
      const el = retailSample.elements.find((e) => e.id === n.elementId)!;
      let parentId: string | null = null;
      if (el.kind === "buc" && !el.isDefault) parentId = el.businessId;
      if (el.kind === "activity" && el.bucId) {
        const buc = retailSample.elements.find((e) => e.id === el.bucId);
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

  it("全体ボードの小枠どうしが重ならない", () => {
    const board = retailSample.boards.find((b) => b.id === "board_overview")!;
    const frames = board.nodes
      .filter((n) => retailSample.elements.find((e) => e.id === n.elementId)?.kind === "buc")
      .map((n) => ({ id: n.elementId, x: n.x, y: n.y, w: n.width!, h: n.height! }));
    for (const a of frames) {
      for (const b of frames) {
        if (a.id >= b.id) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} と ${b.id}`).toBe(false);
      }
    }
  });

  it("1 日の締めは営業中から入金済みまで、発注は発注済みから入荷済みまで状態が進む", () => {
    const rels = retailSample.relations;
    const goes = (usecase: string, state: string) => rels.some((r) => r.kind === "usecaseState" && r.sourceId === usecase && r.targetId === state);
    expect(goes("uc_register_sale", "st_day_open")).toBe(true);
    expect(goes("uc_record_cash", "st_day_counted")).toBe(true);
    expect(goes("uc_issue_daily_report", "st_day_reconciled")).toBe(true);
    expect(goes("uc_send_report", "st_day_reported")).toBe(true);
    expect(goes("uc_record_deposit", "st_day_deposited")).toBe(true);
    expect(goes("uc_register_order", "st_po_placed")).toBe(true);
    expect(goes("uc_register_receiving", "st_po_received")).toBe(true);
  });

  it("会計システムが、売掛金と入金の管理・消し込みの操作の対象になり、売掛金・入金を保存する", () => {
    const rels = retailSample.relations;
    const usecasesOf = (act: string) => rels.filter((r) => r.kind === "activityUsecase" && r.sourceId === act).map((r) => r.targetId);
    for (const act of ["act_manage_settlement", "act_clear_receivable"]) {
      expect(usecasesOf(act).some((uc) => rels.some((r) => r.kind === "usecaseSystem" && r.sourceId === uc && r.targetId === "sys_accounting")), act).toBe(true);
    }
    for (const info of ["info_receivable", "info_settlement"]) {
      expect(rels.some((r) => r.kind === "informationSystem" && r.sourceId === info && r.targetId === "sys_accounting"), info).toBe(true);
    }
    expect(rels.some((r) => r.kind === "usecaseState" && r.sourceId === "uc_clear_receivable" && r.targetId === "st_rec_cleared")).toBe(true);
  });

  it("会計システムで損益計算書 (PL) と貸借対照表 (BS) を見られ、売掛金は BS に、売上は PL につながる", () => {
    const rels = retailSample.relations;
    for (const info of ["info_pl", "info_bs"]) {
      expect(rels.some((r) => r.kind === "systemInformation" && r.sourceId === "sys_accounting" && r.targetId === info), info).toBe(true);
    }
    expect(rels.some((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_view_pl" && r.targetId === "info_pl")).toBe(true);
    expect(rels.some((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_view_bs" && r.targetId === "info_bs")).toBe(true);
    expect(rels.some((r) => r.kind === "informationRelated" && [r.sourceId, r.targetId].sort().join() === ["info_bs", "info_receivable"].join())).toBe(true);
  });

  it("ホームのサンプルの一覧に「店舗の業務」があり、開くたびに新しいモデルを作る", () => {
    const entry = SAMPLES.find((s) => s.id === "retail");
    expect(entry?.title).toBe("店舗の業務");
    expect(entry!.create()).toEqual(retailSample);
    expect(entry!.create()).not.toBe(entry!.create());
  });
});
