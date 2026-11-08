import { informationPlaces } from "../../model/placement";
import { describe, expect, it } from "vitest";
import { createAccountingSample, accountingSample, SAMPLES } from "..";
import { traceToActors, traceWarnings } from "../../model/trace";
import { checkIntegrity, DEFAULT_CARD_SIZE, DEFAULT_FRAME_SIZE, RELATION_KINDS, validateModel } from "../../model";
import type { BoardNode } from "../../model";

describe("経理業務サンプル", () => {
  it("スキーマ検証と参照整合性検査を通る", () => {
    const r = validateModel(JSON.parse(JSON.stringify(accountingSample)));
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(checkIntegrity(accountingSample)).toEqual([]);
  });

  it("すべての要素が担い手まで辿れて、警告も出ない", () => {
    expect(traceToActors(accountingSample).problems.map((p) => `${p.elementId}: ${p.reason}`)).toEqual([]);
    expect(traceToActors(accountingSample).errors.map((e) => e.reason)).toEqual([]);
    // 1 つの業務に付くアクターは主担当の 1 人 (警告も出ない)
    expect(traceWarnings(accountingSample).map((w) => `${w.elementId}: ${w.reason}`)).toEqual([]);
  });

  it("業務・登場人物・課題などの件数", () => {
    const count = (kind: string) => accountingSample.elements.filter((e) => e.kind === kind).length;
    expect(count("business")).toBe(6);
    expect(count("actor")).toBe(6);
    expect(count("externalActor")).toBe(5);
    expect(count("system")).toBe(3);
    expect(count("ledger")).toBe(3);
    expect(count("buc")).toBe(6 + 3);
    expect(count("activity")).toBeGreaterThanOrEqual(15);
    expect(count("usecase")).toBeGreaterThanOrEqual(10);
    expect(count("information")).toBe(12);
    expect(count("state")).toBe(9);
    expect(count("variation")).toBe(3);
    expect(count("condition")).toBe(3);
    expect(count("issue")).toBe(5);
    expect(accountingSample.boards.map((b) => b.name)).toEqual(["全体", "請求・支払から決算まで", "情報と状態"]);
  });

  it("0.1.0 からある関係の種類と、操作の対象 (usecaseSystem) がすべて使われている (新しい種類は見本のネットショップで使う)", () => {
    const kinds = new Set(accountingSample.relations.map((r) => r.kind));
    const legacy = RELATION_KINDS.slice(0, RELATION_KINDS.indexOf("usecaseState") + 1);
    for (const k of [...legacy, "usecaseSystem"] as const) expect(kinds.has(k), k).toBe(true);
    // システムは作業の担当にならない
    const kindOf = new Map(accountingSample.elements.map((e) => [e.id, e.kind]));
    expect(accountingSample.relations.some((r) => r.kind === "actorActivity" && kindOf.get(r.sourceId) === "system")).toBe(false);
  });

  it("「請求・売掛金管理」にだけ既定でない活動があり、その業務の作業はすべて活動に入っている", () => {
    const nonDefault = accountingSample.elements.filter((e) => e.kind === "buc" && !e.isDefault);
    expect(nonDefault.every((b) => b.kind === "buc" && b.businessId === "biz_billing")).toBe(true);
    expect(nonDefault).toHaveLength(3);
    expect(accountingSample.elements.some((e) => e.kind === "activity" && e.bucId === "buc_default_billing")).toBe(false);
  });

  it("課題は業務・作業・操作のどれかを指し、いちばん重い課題には 4 つの分析が入っている", () => {
    const ids = new Set(accountingSample.elements.map((e) => e.id));
    for (const e of accountingSample.elements) {
      if (e.kind !== "issue") continue;
      expect(e.targetIds.length).toBeGreaterThan(0);
      for (const t of e.targetIds) expect(ids.has(t), `${e.id} の対象 ${t}`).toBe(true);
    }
    const top = accountingSample.elements.find((e) => e.kind === "issue" && e.severity === 5);
    expect(top?.kind === "issue" && top.analysis ? Object.keys(top.analysis).sort() : []).toEqual(["cause", "impact", "location", "phenomenon"]);
  });

  it("createAccountingSample は独立したコピーを返す", () => {
    const a = createAccountingSample();
    a.elements.pop();
    expect(createAccountingSample().elements.length).toBe(accountingSample.elements.length);
  });

  it("「全体」ボードで子のカードと小枠が親の枠に収まる", () => {
    const board = accountingSample.boards.find((b) => b.id === "board_overview")!;
    const node = (id: string) => board.nodes.find((n) => n.elementId === id);
    const rect = (n: BoardNode) => {
      const el = accountingSample.elements.find((e) => e.id === n.elementId)!;
      const size = el.kind === "business" || el.kind === "buc" ? DEFAULT_FRAME_SIZE[el.kind] : DEFAULT_CARD_SIZE;
      return { x: n.x, y: n.y, w: n.width ?? size.width, h: n.height ?? size.height };
    };
    let checked = 0;
    for (const n of board.nodes) {
      const el = accountingSample.elements.find((e) => e.id === n.elementId)!;
      let parentId: string | null = null;
      if (el.kind === "buc" && !el.isDefault) parentId = el.businessId;
      if (el.kind === "activity" && el.bucId) {
        const buc = accountingSample.elements.find((e) => e.id === el.bucId);
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
    const board = accountingSample.boards.find((b) => b.id === "board_overview")!;
    const frames = board.nodes
      .filter((n) => accountingSample.elements.find((e) => e.id === n.elementId)?.kind === "buc")
      .map((n) => ({ id: n.elementId, x: n.x, y: n.y, w: n.width!, h: n.height! }));
    for (const a of frames) {
      for (const b of frames) {
        if (a.id >= b.id) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} と ${b.id}`).toBe(false);
      }
    }
  });

  it("売掛金は未入金から消込済みまで、支払は受領済みから支払済みまで、月次決算は調整中から確定まで状態が進む", () => {
    const rels = accountingSample.relations;
    const goes = (usecase: string, state: string) => rels.some((r) => r.kind === "usecaseState" && r.sourceId === usecase && r.targetId === state);
    expect(goes("uc_issue_invoice", "st_rec_open")).toBe(true);
    expect(goes("uc_clear_receivable", "st_rec_partial")).toBe(true);
    expect(goes("uc_clear_receivable", "st_rec_cleared")).toBe(true);
    expect(goes("uc_register_vendor_invoice", "st_pay_received")).toBe(true);
    expect(goes("uc_approve_payment", "st_pay_approved")).toBe(true);
    expect(goes("uc_issue_transfer", "st_pay_paid")).toBe(true);
    expect(goes("uc_adjust_entry", "st_month_open")).toBe(true);
    expect(goes("uc_issue_trial", "st_month_trial")).toBe(true);
    expect(goes("uc_close_month", "st_month_closed")).toBe(true);
  });

  it("会計システムが、売掛金と入金の管理・消し込みの操作の対象になり、売掛金・入金を保存する", () => {
    const rels = accountingSample.relations;
    const usecasesOf = (act: string) => rels.filter((r) => r.kind === "activityUsecase" && r.sourceId === act).map((r) => r.targetId);
    for (const act of ["act_manage_receipt", "act_clear_receivable"]) {
      expect(usecasesOf(act).some((uc) => rels.some((r) => r.kind === "usecaseSystem" && r.sourceId === uc && r.targetId === "sys_accounting")), act).toBe(true);
    }
    // 置き場所は操作から導く: 売掛金・入金・買掛金・仕訳・試算表は会計システムに保存される
    const places = informationPlaces(accountingSample);
    for (const info of ["info_receivable", "info_receipt", "info_payable", "info_journal", "info_trial"]) {
      expect(places.get(info)?.find((p) => p.id === "sys_accounting")?.roles, info).toContain("store");
    }
  });

  it("会計システムで損益計算書 (PL) と貸借対照表 (BS) を見られ、売掛金は BS に、売上は PL につながる", () => {
    const rels = accountingSample.relations;
    const places = informationPlaces(accountingSample);
    for (const info of ["info_pl", "info_bs"]) {
      expect(places.get(info)?.find((p) => p.id === "sys_accounting")?.roles, info).toContain("source");
    }
    expect(rels.some((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_view_pl" && r.targetId === "info_pl" && r.access === "read")).toBe(true);
    expect(rels.some((r) => r.kind === "usecaseInformation" && r.sourceId === "uc_view_bs" && r.targetId === "info_bs")).toBe(true);
    expect(rels.some((r) => r.kind === "informationRelated" && [r.sourceId, r.targetId].sort().join() === ["info_bs", "info_receivable"].join())).toBe(true);
  });

  it("ホームのサンプルの一覧に「経理業務」があり、開くたびに新しいモデルを作る", () => {
    const entry = SAMPLES.find((s) => s.id === "accounting");
    expect(entry?.title).toBe("経理業務");
    expect(entry!.create()).toEqual(accountingSample);
    expect(entry!.create()).not.toBe(entry!.create());
  });
});
