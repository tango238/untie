import { describe, expect, it } from "vitest";
import { isValidElementShape, validateModel } from "../validate";
import { emptyModel } from "../types";
import { sample } from "./helpers";

type Json = Record<string, any>;
const json = (): Json => JSON.parse(JSON.stringify(sample()));

function errorsOf(j: unknown): string[] {
  const r = validateModel(j);
  if (r.ok) throw new Error("検証が通ってしまいました");
  return r.errors;
}

describe("validateModel: スキーマ", () => {
  it("サンプルと空モデルは通る", () => {
    expect(validateModel(json()).ok).toBe(true);
    expect(validateModel(emptyModel()).ok).toBe(true);
  });

  it("オブジェクトでないものは失敗する", () => {
    expect(errorsOf(null).length).toBeGreaterThan(0);
    expect(errorsOf([]).length).toBeGreaterThan(0);
  });

  it("必須項目の欠落を日本語で報告する", () => {
    const j = json();
    delete j.meta;
    expect(errorsOf(j)).toContain("(全体): 必須項目「meta」がありません");
  });

  it("未知の項目・型違い・範囲外を位置つきで報告する", () => {
    const j = json();
    j.version = 2;
    j.extra = 1;
    const i = j.elements.findIndex((e: Json) => e.kind === "issue");
    j.elements[i].severity = 6;
    const errors = errorsOf(j);
    expect(errors.some((e) => e.startsWith("version:"))).toBe(true);
    expect(errors).toContain("(全体): 未知の項目「extra」があります");
    expect(errors).toContain(`elements[${i}].severity: 5 以下である必要があります`);
  });

  it("要素の oneOf のノイズは出さず、その種類の問題だけを出す", () => {
    const j = json();
    const i = j.elements.findIndex((e: Json) => e.kind === "activity");
    delete j.elements[i].bucId;
    const errors = errorsOf(j);
    expect(errors).toEqual([`elements[${i}]: 必須項目「bucId」がありません`]);
  });

  it("不明な kind は要素の種類が不正と報告する", () => {
    const j = json();
    j.elements[0].kind = "window";
    expect(errorsOf(j)).toEqual(["elements[0].kind: 要素の種類が不正です"]);
  });

  it("id の文字種・ボード 0 件・重複した課題対象を弾く", () => {
    const j = json();
    j.elements[0].id = "あ いう";
    expect(errorsOf(j).some((e) => e.startsWith("elements[0].id:"))).toBe(true);

    const k = json();
    k.boards = [];
    expect(errorsOf(k)).toContain("boards: 1 件以上必要です");

    const l = json();
    const i = l.elements.findIndex((e: Json) => e.kind === "issue");
    l.elements[i].targetIds = ["biz_checkin", "biz_checkin"];
    expect(errorsOf(l)).toContain(`elements[${i}].targetIds: 重複した値があります`);
  });
});

describe("validateModel: 参照整合性 (画面・非機能要件のシステム)", () => {
  it("画面・非機能要件の systemId はシステムを指す (帳票・存在しない要素は不可)", () => {
    const base = JSON.parse(JSON.stringify(emptyModel()));
    base.elements = [
      { id: "sys_a", kind: "system", name: "A" },
      { id: "ldg_a", kind: "ledger", name: "台帳" },
      { id: "scr_a", kind: "screen", name: "画面", systemId: "ldg_a" },
      { id: "nfr_a", kind: "nfr", name: "要件", systemId: "nope", category: "security" },
    ];
    const r = validateModel(base);
    const errors = r.ok ? [] : r.errors;
    expect(errors.some((e) => e.includes("systemId ldg_a はシステムではありません"))).toBe(true);
    expect(errors.some((e) => e.includes("システム nope が存在しません"))).toBe(true);
    base.elements[2].systemId = "sys_a";
    base.elements[3].systemId = "sys_a";
    expect(validateModel(base).ok).toBe(true);
    // 分類は IPA の 6 分類だけ
    base.elements[3].category = "usability";
    expect(validateModel(base).ok).toBe(false);
  });
});

describe("validateModel: 参照整合性", () => {
  it("要素 id の重複", () => {
    const j = json();
    j.elements[1].id = j.elements[0].id;
    expect(errorsOf(j).some((e) => e.includes("要素の id が重複"))).toBe(true);
  });

  it("関係の両端が存在しない", () => {
    const j = json();
    j.relations[0].sourceId = "nope";
    j.relations[1].targetId = "nope2";
    const errors = errorsOf(j);
    expect(errors.some((e) => e.includes("始点 nope が存在しません"))).toBe(true);
    expect(errors.some((e) => e.includes("終点 nope2 が存在しません"))).toBe(true);
  });

  it("関係の kind が両端と合わない", () => {
    const j = json();
    j.relations[0].kind = "activityUsecase";
    expect(errorsOf(j).some((e) => e.includes("一致しません"))).toBe(true);
  });

  it("引けない組み合わせの関係", () => {
    const j = json();
    j.relations.push({ id: "rel_bad", kind: "actorBusiness", sourceId: "act_clean", targetId: "actor_front" });
    expect(errorsOf(j).some((e) => e.includes("線で結べません"))).toBe(true);
  });

  it("取得・保存の区別 (access) は、操作が扱う情報の関係にだけ付けられる", () => {
    const j = json();
    const perf = j.relations.find((r: { kind: string }) => r.kind === "actorActivity");
    perf.access = "read";
    expect(errorsOf(j).some((e) => e.includes(perf.id) && e.includes("access"))).toBe(true);
    const ok = json();
    ok.relations.find((r: { kind: string }) => r.kind === "usecaseInformation").access = "write";
    expect(validateModel(ok).ok).toBe(true);
    const bad = json();
    bad.relations.find((r: { kind: string }) => r.kind === "usecaseInformation").access = "readwrite";
    expect(validateModel(bad).ok).toBe(false);
  });

  it("関係の重複 (無向は向き違いも重複)", () => {
    const j = json();
    j.relations.push({ ...j.relations[0], id: "rel_dup" });
    j.relations.push({ id: "rel_rev", kind: "informationRelated", sourceId: "info_guest", targetId: "info_reservation" });
    const errors = errorsOf(j);
    expect(errors.some((e) => e.includes("rel_dup は") && e.includes("重複"))).toBe(true);
    expect(errors.some((e) => e.includes("rel_rev は") && e.includes("重複"))).toBe(true);
  });

  it("自己参照", () => {
    const j = json();
    j.relations.push({ id: "rel_self", kind: "informationRelated", sourceId: "info_room", targetId: "info_room" });
    expect(errorsOf(j).some((e) => e.includes("自己参照"))).toBe(true);
  });

  it("activity.bucId / buc.businessId が存在しない、または種類が違う", () => {
    const j = json();
    const a = j.elements.find((e: Json) => e.id === "act_clean");
    a.bucId = "nope";
    const b = j.elements.find((e: Json) => e.id === "buc_dining");
    b.businessId = "actor_front";
    const errors = errorsOf(j);
    expect(errors.some((e) => e.includes("活動 nope が存在しません"))).toBe(true);
    expect(errors.some((e) => e.includes("は業務ではありません"))).toBe(true);

    const k = json();
    k.elements.find((e: Json) => e.id === "act_clean").bucId = "biz_stay";
    expect(errorsOf(k).some((e) => e.includes("は活動ではありません"))).toBe(true);
    const l = json();
    l.elements.find((e: Json) => e.id === "buc_dining").businessId = "nope";
    expect(errorsOf(l).some((e) => e.includes("業務 nope が存在しません"))).toBe(true);
  });

  it("業務ごとの既定の活動はちょうど 1 つ", () => {
    const none = json();
    none.elements = none.elements.filter((e: Json) => !(e.kind === "buc" && e.isDefault && e.businessId === "biz_stay"));
    // 既定の活動に属していた作業は別活動へ
    none.elements.find((e: Json) => e.id === "act_record_extra").bucId = "buc_dining";
    expect(errorsOf(none).some((e) => e.includes("既定の活動が 0 個"))).toBe(true);

    const two = json();
    two.elements.find((e: Json) => e.id === "buc_dining").isDefault = true;
    expect(errorsOf(two).some((e) => e.includes("既定の活動が 2 個"))).toBe(true);
  });

  it("課題の対象が存在しない、または対象にできない種類", () => {
    const j = json();
    const issue = j.elements.find((e: Json) => e.id === "issue_manual_entry");
    issue.targetIds = ["nope", "info_reservation"];
    const errors = errorsOf(j);
    expect(errors.some((e) => e.includes("対象 nope が存在しません"))).toBe(true);
    expect(errors.some((e) => e.includes("登場人物・業務・作業・操作・画面ではありません"))).toBe(true);
  });

  it("課題の対象に、登場人物と業務・作業・操作が混ざっている", () => {
    const j = json();
    const issue = j.elements.find((e: Json) => e.id === "issue_manual_entry");
    issue.targetIds = ["actor_front"];
    expect(validateModel(j).ok).toBe(true);
    issue.targetIds = ["actor_front", "biz_checkin"];
    expect(errorsOf(j).some((e) => e.includes("混ざっています"))).toBe(true);
  });

  it("ボードのノード: 存在しない要素・重複・課題・既定の活動", () => {
    const j = json();
    const nodes = j.boards[1].nodes;
    nodes.push({ elementId: "nope", x: 0, y: 0 });
    nodes.push({ ...nodes[0] });
    nodes.push({ elementId: "issue_manual_entry", x: 0, y: 0 });
    nodes.push({ elementId: "buc_default_stay", x: 0, y: 0 });
    const errors = errorsOf(j);
    expect(errors.some((e) => e.includes("要素 nope が存在しません"))).toBe(true);
    expect(errors.some((e) => e.includes("複数回置かれています"))).toBe(true);
    expect(errors.some((e) => e.includes("課題") && e.includes("置かれています"))).toBe(true);
    expect(errors.some((e) => e.includes("既定の活動") && e.includes("置かれています"))).toBe(true);
  });

  it("ボードの線: 存在しない関係・重複・不正な辺", () => {
    const j = json();
    const relId = j.relations[0].id;
    j.boards[1].edges = [{ relationId: "nope" }, { relationId: relId, sourceSide: "top" }, { relationId: relId }];
    const errors = errorsOf(j);
    expect(errors.some((e) => e.includes("線の関係 nope が存在しません"))).toBe(true);
    expect(errors.some((e) => e.includes("線の設定が複数あります"))).toBe(true);
    j.boards[1].edges = [{ relationId: relId, sourceSide: "middle" }];
    expect(validateModel(j).ok).toBe(false);
  });

  it("ボード id の重複", () => {
    const j = json();
    j.boards[1].id = j.boards[0].id;
    expect(errorsOf(j).some((e) => e.includes("ボードの id が重複"))).toBe(true);
  });
});

describe("validateModel: 追加の検査", () => {
  it("activity.bucId の型違いは 1 件にまとめて報告する", () => {
    const j = json();
    const i = j.elements.findIndex((e: Json) => e.kind === "activity");
    j.elements[i].bucId = 5;
    expect(errorsOf(j)).toEqual([`elements[${i}].bucId: 文字列の id か null である必要があります`]);
  });

  it("要素と関係・ボードをまたいだ id の重複を報告する", () => {
    const j = json();
    j.relations[0].id = j.elements[0].id;
    j.boards[0].id = j.elements[1].id;
    const errors = errorsOf(j);
    expect(errors.some((e) => e.includes(j.elements[0].id) && e.includes("要素と関係"))).toBe(true);
    expect(errors.some((e) => e.includes(j.elements[1].id) && e.includes("要素とボード"))).toBe(true);
  });

  it("業務・活動のノードに width / height が無いと報告する", () => {
    const j = json();
    const node = j.boards[0].nodes.find((n: Json) => n.elementId === "biz_checkin");
    delete node.width;
    expect(errorsOf(j).some((e) => e.includes("width と height が必要"))).toBe(true);
  });

  it("既定の活動の名前が業務名と違うと報告する", () => {
    const j = json();
    const buc = j.elements.find((e: Json) => e.kind === "buc" && e.isDefault && e.businessId === "biz_checkin");
    buc.name = "違う名前";
    expect(errorsOf(j).some((e) => e.includes("業務名") && e.includes("一致しません"))).toBe(true);
  });
});

describe("isValidElementShape", () => {
  it("サンプルの全要素が通り、項目が欠けた・型が違う・種類が不明な要素は通らない", () => {
    for (const e of sample().elements) expect(isValidElementShape(JSON.parse(JSON.stringify(e)))).toBe(true);
    expect(isValidElementShape({ id: "i", kind: "issue", name: "x", severity: 3 })).toBe(false);
    expect(isValidElementShape({ id: "v", kind: "variation", name: "x", contextId: null })).toBe(false);
    expect(isValidElementShape({ id: "a", kind: "activity", name: "x", bucId: 5 })).toBe(false);
    expect(isValidElementShape({ id: "a", kind: "mystery", name: "x" })).toBe(false);
    expect(isValidElementShape(null)).toBe(false);
    expect(isValidElementShape("x")).toBe(false);
  });
});

describe("validateModel: 作業の起点 (0.4.1)", () => {
  it("起点の循環はエラーにしない。種類の合わない起点・自己参照・空の triggerNote はエラー", () => {
    const j = json();
    j.relations.push({ id: "r_t1", kind: "activityTrigger", sourceId: "act_hand_key", targetId: "act_collect_key" });
    j.relations.push({ id: "r_t2", kind: "activityTrigger", sourceId: "act_collect_key", targetId: "act_hand_key" });
    expect(validateModel(j).ok).toBe(true);
    const bad = json();
    bad.relations.push({ id: "r_b", kind: "activityTrigger", sourceId: "uc_calc_charge", targetId: "act_clean" });
    expect(errorsOf(bad).join()).toMatch(/線で結べません/);
    // kind と両端が食い違う (eventActivity なのに始点が作業、activityTrigger なのに始点がイベント)
    const mismatch = json();
    mismatch.relations.push({ id: "r_m1", kind: "eventActivity", sourceId: "act_hand_key", targetId: "act_collect_key" });
    expect(errorsOf(mismatch).join()).toMatch(/関係 r_m1 の kind「eventActivity」が両端の種類から決まる「activityTrigger」と一致しません/);
    const mismatch2 = json();
    mismatch2.relations.push({ id: "r_m2", kind: "activityTrigger", sourceId: "ev_checkout_day", targetId: "act_hand_key" });
    expect(errorsOf(mismatch2).join()).toMatch(/関係 r_m2 の kind「activityTrigger」が両端の種類から決まる「eventActivity」と一致しません/);
    const self = json();
    self.relations.push({ id: "r_s", kind: "activityTrigger", sourceId: "act_clean", targetId: "act_clean" });
    expect(errorsOf(self).join()).toMatch(/自己参照/);
    const empty = json();
    empty.elements.find((e: Json) => e.id === "act_clean").triggerNote = "";
    expect(errorsOf(empty).length).toBeGreaterThan(0);
  });
});
