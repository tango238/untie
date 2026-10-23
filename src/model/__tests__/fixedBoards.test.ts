import { describe, expect, it } from "vitest";
import {
  FIXED_LAYERS,
  addToGroup,
  filterGroups,
  fixedBoardId,
  fixedGroups,
  linkCandidates,
  linkToGroup,
  parseFixedBoardId,
  unlinkFromGroup,
} from "../fixedBoards";
import { validateModel } from "../validate";
import { emptyModel } from "../types";
import { okModel, sample } from "./helpers";

const group = (m: ReturnType<typeof sample>, layer: Parameters<typeof fixedGroups>[1], key: string) =>
  fixedGroups(m, layer).find((g) => g.key === key)!;
const names = (items: { name: string }[]) => items.map((e) => e.name);

describe("固定ボードの id", () => {
  it("レイヤーと相互に変換でき、自由ボードの id は null", () => {
    for (const l of FIXED_LAYERS) expect(parseFixedBoardId(fixedBoardId(l))).toBe(l);
    expect(parseFixedBoardId("board_overview")).toBeNull();
    expect(parseFixedBoardId("fixed:nope")).toBeNull();
  });
});

describe("fixedGroups", () => {
  it("登場人物: アクター・外部アクター・システム・帳票の 4 枠", () => {
    const gs = fixedGroups(sample(), "actor");
    expect(gs.map((g) => g.title)).toEqual(["アクター", "外部アクター", "システム", "帳票"]);
    expect(names(gs[1]!.items)).toEqual(["宿泊客", "旅行会社"]);
    expect(names(gs[2]!.items)).toEqual(["宿泊管理システム", "会計システム", "予約サイト", "決済サービス"]);
    expect(names(gs[3]!.items)).toEqual(["宿泊者名簿", "清掃チェック表"]);
  });

  it("帳票の枠に足すと帳票を作る", () => {
    const m = sample();
    const r = addToGroup(m, fixedGroups(m, "actor")[3]!, "予約台帳");
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.elements.find((e) => e.id === r.id)).toMatchObject({ kind: "ledger", name: "予約台帳" });
  });

  it("コンテキスト: 1 枠に並べる。情報はコンテキストごと、未分類は中身があるときだけ", () => {
    const m = sample();
    expect(names(fixedGroups(m, "context")[0]!.items)).toEqual(["予約", "顧客", "客室", "料金"]);
    const gs = fixedGroups(m, "information");
    expect(gs.map((g) => g.title)).toEqual(["予約", "顧客", "客室", "料金"]);
    expect(names(group(m, "information", "ctx_charge").items)).toEqual(["料金プラン", "請求"]);
    const r = addToGroup(m, group(m, "information", "ctx_room"), "鍵");
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.elements.find((e) => e.id === r.id)).toMatchObject({ contextId: "ctx_room" });
    expect(fixedGroups(emptyModel(), "information").map((g) => g.title)).toEqual(["未分類"]);
  });

  it("業務: アクターごとに主担当の業務。主担当の無い業務は「主担当なし」", () => {
    const m = sample();
    expect(names(group(m, "business", "actor_front").items)).toEqual(["チェックイン", "滞在中の対応", "チェックアウト"]);
    // サンプルの業務はすべて主担当がいる
    expect(fixedGroups(m, "business").some((g) => g.key === "__none")).toBe(false);
    const m2 = okModel(addToGroup(m, { ...group(m, "business", "actor_front"), link: { type: "none" } }));
    expect(names(group(m2, "business", "__none").items)).toEqual(["新しい業務"]);
  });

  it("活動: 業務ごと。既定の活動は出さない", () => {
    const m = sample();
    expect(names(group(m, "buc", "biz_stay").items)).toEqual(["客室対応", "飲食提供"]);
    expect(group(m, "buc", "biz_checkin").items).toHaveLength(0);
  });

  it("作業: 業務に直接属するもの (既定の活動) と活動ごと", () => {
    const m = sample();
    const def = group(m, "activity", "buc_default_checkin");
    expect(def).toMatchObject({ title: "チェックイン", subtitle: "業務 (活動なし)", parentId: "biz_checkin" });
    expect(def.items).toHaveLength(4);
    expect(group(m, "activity", "buc_dining")).toMatchObject({ title: "飲食提供", parentId: "buc_dining" });
    expect(names(group(m, "activity", "buc_default_stay").items)).toEqual(["追加料金を記録する"]);
  });

  it("操作: 作業ごと。同じ操作が複数の枠に出る", () => {
    const m = sample();
    expect(names(group(m, "usecase", "act_confirm_reservation").items)).toEqual(["予約を確定する", "予約を検索する"]);
    expect(names(group(m, "usecase", "act_confirm_arrival").items)).toEqual(["予約を検索する"]);
  });

  it("操作: 作業の枠を活動の段落に分け、活動の順に並べる。中身の無い活動は出さない", () => {
    const m = sample();
    const gs = fixedGroups(m, "usecase");
    const sectionKeys = [...new Set(gs.map((g) => g.section?.key))];
    const bucOrder = fixedGroups(m, "activity").map((g) => g.key);
    // 段落は活動のボードと同じ並び (既定の活動 → 活動)
    expect(sectionKeys.filter((k) => k !== "__none")).toEqual(bucOrder.filter((k) => sectionKeys.includes(k)));
    // 同じ段落の枠は続けて並ぶ
    const runs = gs.filter((g, i) => i === 0 || g.section?.key !== gs[i - 1]!.section?.key).length;
    expect(runs).toBe(sectionKeys.length);
    const dining = gs.filter((g) => g.section?.key === "buc_dining");
    expect(dining[0]!.section).toMatchObject({ title: "飲食提供", parentId: "buc_dining" });
    expect(dining.map((g) => g.parentId)).toContain("act_room_service");
    expect(group(m, "usecase", "act_confirm_reservation").section).toMatchObject({ key: "buc_default_reservation", title: "予約受付" });
  });

  it("状態: 状態グループごと。「グループなし」は常に出す", () => {
    const gs = fixedGroups(sample(), "state");
    expect(gs.map((g) => g.title)).toEqual(["予約の状態", "部屋の状態", "グループなし"]);
  });

  it("上位が無いときは、作れる枠だけ出す", () => {
    const m = emptyModel();
    expect(fixedGroups(m, "buc")).toEqual([]);
    expect(fixedGroups(m, "activity").map((g) => g.title)).toEqual(["未所属"]);
    expect(fixedGroups(m, "usecase").map((g) => [g.title, g.section?.key])).toEqual([["作業なし", "__none"]]);
  });
});

describe("filterGroups", () => {
  it("見出しが一致した枠は全部、それ以外は一致した要素だけ。何も無い枠は出さない", () => {
    const gs = fixedGroups(sample(), "activity");
    const byTitle = filterGroups(gs, "チェックイン");
    expect(byTitle.map((g) => g.title)).toEqual(["チェックイン"]);
    expect(byTitle[0]!.items).toHaveLength(4);
    const byItem = filterGroups(gs, "鍵");
    expect(byItem.map((g) => [g.title, names(g.items)])).toEqual([
      ["チェックイン", ["鍵を渡す"]],
      ["チェックアウト", ["鍵を回収する"]],
    ]);
    expect(filterGroups(gs, "  ")).toBe(gs);
    expect(filterGroups(gs, "存在しない名前")).toEqual([]);
  });
});

describe("枠への追加・紐づけ", () => {
  it("活動の枠に作業を足すと、その活動に所属する", () => {
    const m = sample();
    const r = addToGroup(m, group(m, "activity", "buc_dining"));
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.elements.find((e) => e.id === r.id)).toMatchObject({ kind: "activity", name: "新しい作業", bucId: "buc_dining" });
    expect(validateModel(r.model).ok).toBe(true);
  });

  it("業務の枠に活動を足すと、その業務の活動になる", () => {
    const m = sample();
    const r = addToGroup(m, group(m, "buc", "biz_checkin"));
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.elements.find((e) => e.id === r.id)).toMatchObject({ kind: "buc", businessId: "biz_checkin", isDefault: false });
  });

  it("関係で結ぶ枠に足すと、要素と関係を 1 回で作る", () => {
    const m = sample();
    const r = addToGroup(m, group(m, "usecase", "act_hand_key"), "鍵の受け渡しを記録する");
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.relations.some((x) => x.kind === "activityUsecase" && x.sourceId === "act_hand_key" && x.targetId === r.id)).toBe(true);
    expect(names(group(r.model, "usecase", "act_hand_key").items)).toEqual(["鍵の受け渡しを記録する"]);
  });

  it("状態グループの枠に足すと、そのグループの状態になる", () => {
    const m = sample();
    const r = addToGroup(m, group(m, "state", "group:部屋の状態"));
    if (!r.ok) throw new Error(r.reason);
    expect(r.model.elements.find((e) => e.id === r.id)).toMatchObject({ kind: "state", group: "部屋の状態" });
  });

  it("既存の要素を足す・外す (関係で結ぶ枠だけ)。外しても要素は残る", () => {
    const m = sample();
    const g = group(m, "usecase", "act_hand_key");
    expect(linkCandidates(m, g).map((e) => e.id)).toContain("uc_record_checkin");
    const linked = okModel(linkToGroup(m, g, "uc_record_checkin"));
    const g2 = group(linked, "usecase", "act_hand_key");
    expect(names(g2.items)).toEqual(["チェックインを記録する"]);
    expect(linkCandidates(linked, g2).map((e) => e.id)).not.toContain("uc_record_checkin");
    const unlinked = okModel(unlinkFromGroup(linked, g2, "uc_record_checkin"));
    expect(group(unlinked, "usecase", "act_hand_key").items).toHaveLength(0);
    expect(unlinked.elements.some((e) => e.id === "uc_record_checkin")).toBe(true);
    // 所属で決まる枠では使えない
    expect(linkCandidates(m, group(m, "activity", "buc_dining"))).toEqual([]);
    expect(unlinkFromGroup(m, group(m, "activity", "buc_dining"), "act_room_service").ok).toBe(false);
  });
});
