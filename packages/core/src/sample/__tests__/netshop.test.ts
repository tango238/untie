import { informationPlaces } from "../../model/placement";
import { describe, expect, it } from "vitest";
import { createNetshopSample, netshopSample, SAMPLES } from "..";
import { traceToActors, traceWarnings } from "../../model/trace";
import { checkIntegrity, DEFAULT_CARD_SIZE, DEFAULT_FRAME_SIZE, RELATION_KINDS, validateModel } from "../../model";
import type { BoardNode } from "../../model";

describe("ネットショップサンプル", () => {
  it("スキーマ検証と参照整合性検査を通る", () => {
    const r = validateModel(JSON.parse(JSON.stringify(netshopSample)));
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(checkIntegrity(netshopSample)).toEqual([]);
  });

  it("すべての要素が担い手まで辿れて、警告も出ない (画面の「検証」が空)", () => {
    expect(traceToActors(netshopSample).problems.map((p) => `${p.elementId}: ${p.reason}`)).toEqual([]);
    // 1 つの業務に付くアクターは主担当の 1 人 (警告も出ない)
    expect(traceWarnings(netshopSample).map((w) => `${w.elementId}: ${w.reason}`)).toEqual([]);
  });

  it("業務・登場人物・課題などの件数", () => {
    const count = (kind: string) => netshopSample.elements.filter((e) => e.kind === kind).length;
    expect(count("business")).toBe(7);
    expect(count("actor")).toBe(5);
    expect(count("externalActor")).toBe(3);
    expect(count("system")).toBe(5);
    expect(count("ledger")).toBe(2);
    expect(count("buc")).toBe(7 + 2);
    expect(count("activity")).toBeGreaterThanOrEqual(15);
    expect(count("usecase")).toBeGreaterThanOrEqual(10);
    expect(count("information")).toBe(11);
    expect(count("state")).toBe(11);
    expect(count("variation")).toBe(3);
    expect(count("condition")).toBe(3);
    expect(count("issue")).toBe(5);
    expect(count("event")).toBe(20);
    expect(count("screen")).toBe(10);
    expect(count("nfr")).toBe(4);
    expect(netshopSample.boards.map((b) => b.name)).toEqual(["全体", "入荷から返品・問い合わせまで", "情報と状態"]);
  });

  it("全ての関係の種類が使われている", () => {
    const kinds = new Set(netshopSample.relations.map((r) => r.kind));
    expect(kinds.size).toBe(RELATION_KINDS.length);
  });

  it("「受注処理」にだけ既定でない活動があり、その業務の作業はすべて活動に入っている", () => {
    const nonDefault = netshopSample.elements.filter((e) => e.kind === "buc" && !e.isDefault);
    expect(nonDefault.every((b) => b.kind === "buc" && b.businessId === "biz_order")).toBe(true);
    expect(nonDefault).toHaveLength(2);
    expect(netshopSample.elements.some((e) => e.kind === "activity" && e.bucId === "buc_default_order")).toBe(false);
  });

  it("課題は業務・作業・操作のどれかを指し、いちばん重い課題には 4 つの分析が入っている", () => {
    const ids = new Set(netshopSample.elements.map((e) => e.id));
    for (const e of netshopSample.elements) {
      if (e.kind !== "issue") continue;
      expect(e.targetIds.length).toBeGreaterThan(0);
      for (const t of e.targetIds) expect(ids.has(t), `${e.id} の対象 ${t}`).toBe(true);
    }
    const top = netshopSample.elements.find((e) => e.kind === "issue" && e.severity === 5);
    expect(top?.kind === "issue" && top.analysis ? Object.keys(top.analysis).sort() : []).toEqual(["cause", "impact", "location", "phenomenon"]);
  });

  it("createNetshopSample は独立したコピーを返す", () => {
    const a = createNetshopSample();
    a.elements.pop();
    expect(createNetshopSample().elements.length).toBe(netshopSample.elements.length);
  });

  it("「全体」ボードで子のカードと小枠が親の枠に収まる", () => {
    const board = netshopSample.boards.find((b) => b.id === "board_overview")!;
    const node = (id: string) => board.nodes.find((n) => n.elementId === id);
    const rect = (n: BoardNode) => {
      const el = netshopSample.elements.find((e) => e.id === n.elementId)!;
      const size = el.kind === "business" || el.kind === "buc" ? DEFAULT_FRAME_SIZE[el.kind] : DEFAULT_CARD_SIZE;
      return { x: n.x, y: n.y, w: n.width ?? size.width, h: n.height ?? size.height };
    };
    let checked = 0;
    for (const n of board.nodes) {
      const el = netshopSample.elements.find((e) => e.id === n.elementId)!;
      let parentId: string | null = null;
      if (el.kind === "buc" && !el.isDefault) parentId = el.businessId;
      if (el.kind === "activity" && el.bucId) {
        const buc = netshopSample.elements.find((e) => e.id === el.bucId);
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
    const board = netshopSample.boards.find((b) => b.id === "board_overview")!;
    const frames = board.nodes
      .filter((n) => netshopSample.elements.find((e) => e.id === n.elementId)?.kind === "buc")
      .map((n) => ({ id: n.elementId, x: n.x, y: n.y, w: n.width!, h: n.height! }));
    for (const a of frames) {
      for (const b of frames) {
        if (a.id >= b.id) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} と ${b.id}`).toBe(false);
      }
    }
  });

  it("注文は受付から出荷済みまで、返品は受付から返金まで状態が進む", () => {
    const rels = netshopSample.relations;
    const goes = (usecase: string, state: string) => rels.some((r) => r.kind === "usecaseState" && r.sourceId === usecase && r.targetId === state);
    expect(goes("uc_register_order", "st_ord_received")).toBe(true);
    expect(goes("uc_confirm_order", "st_ord_confirmed")).toBe(true);
    expect(goes("uc_record_payment", "st_ord_paid")).toBe(true);
    expect(goes("uc_record_shipment", "st_ord_shipped")).toBe(true);
    expect(goes("uc_register_return", "st_ret_accepted")).toBe(true);
    expect(goes("uc_record_refund", "st_ret_refunded")).toBe(true);
  });

  it("システムは作業の担当にならない。会計システムは売掛金の計上 (自動の処理)・入金の管理・消し込みの操作の対象になり、売掛金と入金を保存する", () => {
    const rels = netshopSample.relations;
    const kindOf = new Map(netshopSample.elements.map((e) => [e.id, e.kind]));
    expect(rels.some((r) => r.kind === "actorActivity" && kindOf.get(r.sourceId) === "system")).toBe(false);
    // 売掛金の計上は、出荷をきっかけにした自動の処理 (対象: 会計システム)
    expect(rels.some((r) => r.kind === "eventUsecase" && r.sourceId === "ev_shipped" && r.targetId === "uc_register_receivable")).toBe(true);
    expect(rels.some((r) => r.kind === "usecaseSystem" && r.sourceId === "uc_register_receivable" && r.targetId === "sys_accounting")).toBe(true);
    // 入金の管理と消し込みは、会計システムの画面で行う (画面のシステムが対象)
    for (const uc of ["uc_record_payout", "uc_clear_receivable"]) {
      const screen = rels.find((r) => r.kind === "usecaseScreen" && r.sourceId === uc)?.targetId;
      const sys = netshopSample.elements.find((e) => e.id === screen);
      expect(sys?.kind === "screen" && sys.systemId, uc).toBe("sys_accounting");
    }
    // 置き場所は操作から導く: 売掛金・入金は会計システムに保存される
    const places = informationPlaces(netshopSample);
    for (const info of ["info_receivable", "info_payout"]) {
      expect(places.get(info)?.find((p) => p.id === "sys_accounting")?.roles, info).toContain("store");
    }
  });

  it("在庫の引き当ては、注文の確定をきっかけにした自動の処理で、在庫が引き当てられたイベントで終わる", () => {
    const rels = netshopSample.relations;
    expect(netshopSample.elements.some((e) => e.id === "act_allocate")).toBe(false);
    expect(rels.some((r) => r.kind === "eventUsecase" && r.sourceId === "ev_order_confirmed" && r.targetId === "uc_allocate_stock")).toBe(true);
    expect(rels.some((r) => r.kind === "usecaseEvent" && r.sourceId === "uc_allocate_stock" && r.targetId === "ev_stock_allocated")).toBe(true);
  });

  it("会計システムで損益計算書 (PL) と貸借対照表 (BS) を見られ、売掛金は BS に、売上は PL につながる", () => {
    const rels = netshopSample.relations;
    const places = informationPlaces(netshopSample);
    for (const info of ["info_pl", "info_bs"]) {
      expect(places.get(info)?.find((p) => p.id === "sys_accounting")?.roles, info).toContain("source");
    }
    expect(rels.some((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_view_pl" && r.targetId === "info_pl" && r.access === "read")).toBe(true);
    expect(rels.some((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_view_bs" && r.targetId === "info_bs")).toBe(true);
    expect(rels.some((r) => r.kind === "informationRelated" && [r.sourceId, r.targetId].sort().join() === ["info_bs", "info_receivable"].join())).toBe(true);
  });

  it("ホームのサンプルの一覧に「ネットショップの業務」があり、開くたびに新しいモデルを作る", () => {
    const entry = SAMPLES.find((s) => s.id === "netshop");
    expect(entry?.title).toBe("ネットショップの業務");
    expect(entry!.create()).toEqual(netshopSample);
    expect(entry!.create()).not.toBe(entry!.create());
  });
});
