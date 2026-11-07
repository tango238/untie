import { describe, expect, it } from "vitest";
import { addDesignScreens, addTransition, removeDesignScreensById, removeTransition, updateTransition } from "../commands";
import { usedDesignIds } from "../design";
import { addSitemapScreens, checkStateOf, deriveTransitions, designScreenName, entryNotes, entryScreenIds, presentScreenIds, removeSitemapScreens, screensWithDesign, sitemapTree } from "../sitemap";
import { emptyModel, type DesignScreen, type Element, type Relation, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { expectFail, okModel } from "./helpers";

const ELEMENTS: Element[] = [
  { id: "sys_a", kind: "system", name: "予約システム" },
  { id: "sys_b", kind: "system", name: "会計システム" },
  { id: "actor_1", kind: "actor", name: "受付" },
  { id: "actor_2", kind: "actor", name: "支配人" },
  { id: "biz_1", kind: "business", name: "予約" },
  { id: "buc_def", kind: "buc", name: "予約", businessId: "biz_1", isDefault: true },
  { id: "act_1", kind: "activity", name: "受ける", bucId: "buc_def" },
  { id: "act_2", kind: "activity", name: "確認する", bucId: "buc_def", triggerNote: "電話" },
  { id: "act_3", kind: "activity", name: "承認する", bucId: "buc_def" },
  { id: "act_4", kind: "activity", name: "請求する", bucId: "buc_def" },
  { id: "uc_1", kind: "usecase", name: "検索する" },
  { id: "uc_2", kind: "usecase", name: "登録する" },
  { id: "uc_3", kind: "usecase", name: "確認する操作" },
  { id: "uc_4", kind: "usecase", name: "承認する操作" },
  { id: "uc_5", kind: "usecase", name: "請求書を出す" },
  { id: "uc_6", kind: "usecase", name: "自動で通知する" },
  { id: "scr_1", kind: "screen", name: "検索", systemId: "sys_a" },
  { id: "scr_2", kind: "screen", name: "登録", systemId: "sys_a" },
  { id: "scr_3", kind: "screen", name: "確認", systemId: "sys_a" },
  { id: "scr_4", kind: "screen", name: "承認", systemId: "sys_a" },
  { id: "scr_5", kind: "screen", name: "請求", systemId: "sys_b" },
  { id: "scr_6", kind: "screen", name: "通知", systemId: "sys_a" },
  { id: "ev_1", kind: "event", name: "登録された", contextId: null },
  { id: "ev_sys", kind: "event", name: "夜間の締め", contextId: null },
] as Element[];

const PAIRS: [string, string, Relation["kind"]][] = [
  ["actor_1", "act_1", "actorActivity"],
  ["actor_1", "act_2", "actorActivity"],
  ["actor_2", "act_3", "actorActivity"],
  ["actor_2", "act_4", "actorActivity"],
  ["act_1", "uc_1", "activityUsecase"],
  ["act_1", "uc_2", "activityUsecase"],
  ["act_2", "uc_3", "activityUsecase"],
  ["act_3", "uc_4", "activityUsecase"],
  ["act_4", "uc_5", "activityUsecase"],
  ["uc_1", "scr_1", "usecaseScreen"],
  ["uc_2", "scr_2", "usecaseScreen"],
  ["uc_3", "scr_3", "usecaseScreen"],
  ["uc_4", "scr_4", "usecaseScreen"],
  ["uc_5", "scr_5", "usecaseScreen"],
  ["uc_6", "scr_6", "usecaseScreen"],
  ["uc_1", "uc_2", "usecaseNext"],
];

/** 受付: 検索 → 登録 (作業の中)。確認 (受付。起点: 登録の作業) 。承認 (支配人) は担当が違う。請求は別システム */
function base(extra: [string, string, Relation["kind"]][] = []): UntieModel {
  const m = emptyModel();
  m.elements = ELEMENTS.map((e) => ({ ...e }));
  m.relations = [...PAIRS, ...extra].map(([sourceId, targetId, kind]) => ({ id: `rel_${sourceId}_${targetId}`, kind, sourceId, targetId }));
  return m;
}

const ds = (id: string, screenId: string): DesignScreen => ({ id, source: { kind: "screen", screenId } });
const builtin = (id: string, b: "signIn" | "top"): DesignScreen => ({ id, source: { kind: "builtin", builtin: b } });
const all = [ds("d1", "scr_1"), ds("d2", "scr_2"), ds("d3", "scr_3"), ds("d4", "scr_4"), ds("d5", "scr_5"), ds("d6", "scr_6")];
const pairs = (r: { from: string; to: string }[]) => r.map((t) => `${t.from}>${t.to}`);

describe("deriveTransitions: 作業の中", () => {
  it("操作の「次に」に沿って、画面から画面へ遷移を導く", () => {
    expect(pairs(deriveTransitions(base(), "sys_a", all))).toEqual(["d1>d2"]);
  });

  it("片方の画面がサイトマップに無ければ導かない", () => {
    expect(deriveTransitions(base(), "sys_a", [all[0]!])).toEqual([]);
    expect(deriveTransitions(base(), "sys_a", [all[1]!])).toEqual([]);
  });

  it("イベントをはさんだ連鎖 (操作 → イベント → きっかけの操作) も遷移になる", () => {
    const m = base([["uc_2", "ev_1", "usecaseEvent"], ["ev_1", "uc_3", "eventUsecase"]]);
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2", "d2>d3"]);
  });

  it("作業をまたぐ連鎖でも、担当が同じなら遷移になる。担当が違えば遷移にしない", () => {
    const same = base([["uc_2", "uc_3", "usecaseNext"]]);
    expect(pairs(deriveTransitions(same, "sys_a", all))).toContain("d2>d3");
    const differ = base([["uc_2", "uc_4", "usecaseNext"]]);
    expect(pairs(deriveTransitions(differ, "sys_a", all))).not.toContain("d2>d4");
  });

  it("2 つの操作が同じ画面なら遷移にしない", () => {
    const m = base([["uc_3", "scr_2", "usecaseScreen"], ["uc_2", "uc_3", "usecaseNext"]]);
    // 操作 uc_3 の画面を scr_2 (uc_2 と同じ) にする
    m.relations = m.relations.filter((r) => !(r.sourceId === "uc_3" && r.targetId === "scr_3"));
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2"]);
  });
});

describe("deriveTransitions: 作業の間 (起点)", () => {
  it("作業の起点の作業の最後の画面から、最初の画面へ", () => {
    // 受ける (検索 → 登録) → 確認する: 最後は登録、最初は確認
    const m = base([["act_1", "act_2", "activityTrigger"]]);
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2", "d2>d3"]);
  });

  it("起点が別の担当の作業なら遷移にせず、入口の注記にする", () => {
    const m = base([["act_1", "act_3", "activityTrigger"]]);
    const screens = all;
    expect(pairs(deriveTransitions(m, "sys_a", screens))).toEqual(["d1>d2"]);
    const design = { screens, transitions: [{ id: "t1", from: "d1", to: "d2" }] };
    expect(entryNotes(m, "sys_a", design).get("d4")).toEqual(["作業「受ける」から引き継ぎ"]);
  });

  it("起点がイベントなら、そのイベントを出す操作の画面から", () => {
    const m = base([["uc_2", "ev_1", "usecaseEvent"], ["ev_1", "act_2", "eventActivity"]]);
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2", "d2>d3"]);
  });

  it("イベントを出すのがシステムだけなら遷移にせず、注記にする", () => {
    const m = base([["sys_a", "ev_sys", "systemEvent"], ["ev_sys", "act_3", "eventActivity"]]);
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2"]);
    const notes = entryNotes(m, "sys_a", { screens: all, transitions: [{ id: "t", from: "d1", to: "d2" }] });
    expect(notes.get("d4")).toEqual(["イベント「夜間の締め」から"]);
  });

  it("別のシステムの画面からの連鎖は、「○○システムから」の注記になる", () => {
    // 請求 (会計システム) → 承認 (予約システム)。担当は同じ支配人
    const m = base([["act_4", "act_3", "activityTrigger"]]);
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2"]);
    const notes = entryNotes(m, "sys_a", { screens: all, transitions: [{ id: "t", from: "d1", to: "d2" }] });
    expect(notes.get("d4")).toEqual(["会計システムから"]);
  });

  it("起点 (その他) は「起点: ○○」の注記", () => {
    const notes = entryNotes(base(), "sys_a", { screens: all, transitions: [{ id: "t", from: "d1", to: "d2" }] });
    expect(notes.get("d3")).toEqual(["起点: 電話"]);
  });
});

describe("入口と組み込みの画面", () => {
  it("入口は作業ごとに判定する: 作業の最初の画面のうち、起点から遷移で入れないもの (組み込みからの遷移は関係ない)", () => {
    const screens = [builtin("top", "top"), ...all];
    const transitions = [{ id: "t1", from: "top", to: "d1" }, { id: "t2", from: "d1", to: "d2" }];
    // d1 (受ける)・d3 (確認する。起点: 電話)・d4 (承認する)。d2 は最初の画面ではなく、d5 は別のシステム、d6 は作業が無い
    expect(entryScreenIds(base(), "sys_a", { screens })).toEqual(["d1", "d3", "d4"]);
    const notes = entryNotes(base(), "sys_a", { screens, transitions });
    expect([...notes.keys()]).toEqual(["d1", "d3", "d4"]);
    expect(notes.get("d1")).toEqual([]);
    expect(notes.get("d3")).toEqual(["起点: 電話"]);
    expect(notes.has("d2")).toBe(false);
  });

  it("起点から遷移で入れる作業の最初の画面は入口にならない。入れない作業が別にあれば入口", () => {
    const m = base([["act_1", "act_2", "activityTrigger"]]);
    expect(entryScreenIds(m, "sys_a", { screens: all })).toEqual(["d1", "d4"]);
    const shared = base([["act_1", "act_2", "activityTrigger"], ["act_3", "uc_3", "activityUsecase"]]);
    // 承認…ではなく電話の作業も確認の操作を使う: 起点が無い作業の最初の画面なので、d3 は入口 (注記はその作業の分だけ)
    expect(entryScreenIds(shared, "sys_a", { screens: all })).toContain("d3");
  });

  it("トップページ → 入口の画面 (nav)、サインイン → トップページ (afterSubmit)", () => {
    const screens = [builtin("si", "signIn"), builtin("top", "top"), all[0]!, all[1]!];
    const r = deriveTransitions(base(), "sys_a", screens);
    expect(r).toEqual([
      { from: "d1", to: "d2" },
      { from: "top", to: "d1", via: "nav" },
      { from: "si", to: "top", via: "afterSubmit" },
    ]);
  });

  it("トップページが無ければ、サインイン → 入口の画面すべて (afterSubmit)", () => {
    const screens = [builtin("si", "signIn"), all[0]!, all[1]!, all[2]!];
    const r = deriveTransitions(base(), "sys_a", screens);
    expect(r.filter((t) => t.via)).toEqual([
      { from: "si", to: "d1", via: "afterSubmit" },
      { from: "si", to: "d3", via: "afterSubmit" },
    ]);
  });

  it("組み込みの画面からの遷移は、画面を足す・外すたびに今の入口に合わせて付け直す", () => {
    // サインインを先に足し、あとでトップを足すと、サインイン → 入口は消えてサインイン → トップだけになる
    let m = okModel(addSitemapScreens(base(), "sys_a", [{ kind: "builtin", builtin: "signIn" }, { kind: "screen", screenId: "scr_1" }]));
    const names = (x: UntieModel) => x.designs[0]!.transitions.map((t) => `${designScreenName(x, x.designs[0]!.screens.find((s) => s.id === t.from)!)}>${designScreenName(x, x.designs[0]!.screens.find((s) => s.id === t.to)!)}[${t.via ?? ""}]`);
    expect(names(m)).toEqual(["サインイン>検索[afterSubmit]"]);
    m = okModel(addSitemapScreens(m, "sys_a", [{ kind: "builtin", builtin: "top" }]));
    expect(names(m).sort()).toEqual(["サインイン>トップページ[afterSubmit]", "トップページ>検索[nav]"]);
    // 新しく入口になった画面 (確認) にもトップから付く
    m = okModel(addSitemapScreens(m, "sys_a", [{ kind: "screen", screenId: "scr_3" }]));
    expect(names(m)).toContain("トップページ>確認[nav]");
    // 画面を外すと、その先への遷移も消える。入口でなくなる先 (作業の起点で入れるようになったもの) のトップからの遷移も消える
    const id1 = m.designs[0]!.screens.find((s) => s.source.kind === "screen" && s.source.screenId === "scr_3")!.id;
    m = okModel(removeSitemapScreens(m, "sys_a", [id1]));
    expect(names(m)).not.toContain("トップページ>確認[nav]");
  });

  it("label を付けた組み込みの画面からの遷移は、付け直しても残る", () => {
    let m = okModel(addSitemapScreens(base(), "sys_a", [{ kind: "builtin", builtin: "top" }, { kind: "screen", screenId: "scr_1" }]));
    const tr = m.designs[0]!.transitions[0]!;
    m = okModel(updateTransition(m, { systemId: "sys_a", id: tr.id, patch: { label: "はじめる" } }));
    m = okModel(addSitemapScreens(m, "sys_a", [{ kind: "screen", screenId: "scr_3" }]));
    expect(m.designs[0]!.transitions.find((t) => t.id === tr.id)?.label).toBe("はじめる");
  });

  it("消した遷移は、別の画面を足しても戻らない", () => {
    let m = okModel(addSitemapScreens(base(), "sys_a", [{ kind: "screen", screenId: "scr_1" }, { kind: "screen", screenId: "scr_2" }]));
    m = okModel(removeTransition(m, { systemId: "sys_a", id: m.designs[0]!.transitions[0]!.id }));
    m = okModel(addSitemapScreens(m, "sys_a", [{ kind: "screen", screenId: "scr_3" }]));
    expect(m.designs[0]!.transitions).toEqual([]);
  });

  it("最初の操作に画面が無い作業は、連鎖を先へ辿って画面のある操作を最初にする。最後も同じ(手前へ)", () => {
    const m = base([["act_2", "uc_7", "activityUsecase"], ["act_2", "uc_8", "activityUsecase"], ["uc_7", "uc_3", "usecaseNext"], ["uc_3", "uc_8", "usecaseNext"], ["act_1", "act_2", "activityTrigger"]]);
    m.elements.push({ id: "uc_7", kind: "usecase", name: "画面の無い操作" } as Element, { id: "uc_8", kind: "usecase", name: "画面の無い最後の操作" } as Element);
    // 確認する: uc_7 (画面なし) → uc_3 (d3) → uc_8 (画面なし)。最初も最後も d3
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2", "d2>d3"]);
    expect(entryScreenIds(m, "sys_a", { screens: all })).not.toContain("d3");
  });

  it("輪で終わる作業は、輪の中で作業の中の並びが最初の操作を最後・最初の操作とする", () => {
    // 確認する: uc_3 → uc_9 → uc_3 (輪)。前も次も無い操作が無いので、並びが最初の uc_3
    const m = base([["act_2", "uc_9", "activityUsecase"], ["uc_3", "uc_9", "usecaseNext"], ["uc_9", "uc_3", "usecaseNext"], ["act_1", "act_2", "activityTrigger"]]);
    m.elements.push({ id: "uc_9", kind: "usecase", name: "輪の操作" } as Element);
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2", "d2>d3"]);
  });

  it("外部アクターは担当の比較に数えない。担当が空なら通す", () => {
    const customer = (m: UntieModel) => {
      m.elements.push({ id: "ext_1", kind: "externalActor", name: "お客さま" } as Element);
      for (const act of ["act_1", "act_3"]) m.relations.push({ id: `rel_ext_${act}`, kind: "actorActivity", sourceId: "ext_1", targetId: act });
      return m;
    };
    const m = customer(base([["act_1", "act_3", "activityTrigger"]]));
    // お客さまが両方にいても、受付と支配人は違う担当
    expect(pairs(deriveTransitions(m, "sys_a", all))).toEqual(["d1>d2"]);
    // 担当が外部アクターだけの作業は担当が空として通す
    const only = customer(base([["act_1", "act_3", "activityTrigger"]]));
    only.relations = only.relations.filter((r) => !(r.kind === "actorActivity" && r.sourceId === "actor_2"));
    expect(pairs(deriveTransitions(only, "sys_a", all))).toContain("d2>d4");
  });

  it("操作の対象が別のシステムのときも「○○から」の注記になる", () => {
    const m = base([["act_4", "act_3", "activityTrigger"]]);
    m.relations = m.relations.filter((r) => !(r.kind === "usecaseScreen" && r.sourceId === "uc_5"));
    m.relations.push({ id: "rel_t", kind: "usecaseSystem", sourceId: "uc_5", targetId: "sys_b" });
    expect(entryNotes(m, "sys_a", { screens: all, transitions: [] }).get("d4")).toEqual(["会計システムから"]);
  });

  it("すでにある遷移 (同じ from / to) は足さない。導いた結果に重複もない", () => {
    const screens = [builtin("top", "top"), all[0]!, all[1]!];
    const first = deriveTransitions(base(), "sys_a", screens);
    const existing = first.map((t, i) => ({ id: `t${i}`, ...t }));
    expect(deriveTransitions(base(), "sys_a", screens, existing)).toEqual([]);
    expect(new Set(first.map((t) => `${t.from}>${t.to}`)).size).toBe(first.length);
    // 画面を足すと、新しく入口になった画面へだけ足す
    const more = deriveTransitions(base(), "sys_a", [...screens, all[2]!], existing);
    expect(more).toEqual([{ from: "top", to: "d3", via: "nav" }]);
  });
});

describe("木とチェックの状態", () => {
  it("業務 → 作業 → 操作に、届く画面 (対象のシステムのものだけ) を持たせる", () => {
    const tree = sitemapTree(base(), "sys_a");
    expect(tree.map((n) => n.name)).toEqual(["予約"]);
    const biz = tree[0]!;
    expect(biz.children.map((n) => n.name)).toEqual(["受ける", "確認する", "承認する", "請求する"]);
    expect(biz.screenIds).toEqual(["scr_1", "scr_2", "scr_3", "scr_4"]);
    const billing = biz.children[3]!;
    expect(billing.screenIds).toEqual([]);
    expect(billing.children[0]!.screenNames).toEqual([]);
    expect(biz.children[0]!.children[0]!.screenNames).toEqual(["検索"]);
  });

  it("既定でない活動は業務の下に出し、作業はその下に並ぶ", () => {
    const m = base();
    m.elements.push({ id: "buc_x", kind: "buc", name: "窓口", businessId: "biz_1", isDefault: false } as Element);
    const act = m.elements.find((e) => e.id === "act_4")!;
    if (act.kind === "activity") act.bucId = "buc_x";
    const biz = sitemapTree(m, "sys_a")[0]!;
    expect(biz.children.map((n) => `${n.kind}:${n.name}`)).toEqual(["activity:受ける", "activity:確認する", "activity:承認する", "buc:窓口"]);
  });

  it("届く画面がすべてあれば checked、一部なら indeterminate、無ければ unchecked", () => {
    const present = new Set(["scr_1"]);
    expect(checkStateOf(["scr_1"], present)).toBe("checked");
    expect(checkStateOf(["scr_1", "scr_2"], present)).toBe("indeterminate");
    expect(checkStateOf(["scr_2"], present)).toBe("unchecked");
    expect(checkStateOf([], present)).toBe("unchecked");
    expect(presentScreenIds({ screens: [ds("d1", "scr_1"), builtin("top", "top")] })).toEqual(new Set(["scr_1"]));
  });
});

describe("addSitemapScreens", () => {
  it("画面と導いた遷移を 1 回の変更で足し、設計を作る", () => {
    const m = okModel(addSitemapScreens(base(), "sys_a", [{ kind: "builtin", builtin: "top" }, { kind: "screen", screenId: "scr_1" }, { kind: "screen", screenId: "scr_2" }]));
    const d = m.designs[0]!;
    expect(d.screens).toHaveLength(3);
    expect(d.transitions.map((t) => t.via)).toEqual([undefined, "nav"]);
    expect(d.screens[0]!.id).toMatch(/^ds_/);
    expect(d.transitions[0]!.id).toMatch(/^tr_/);
    expect(m.databases).toHaveLength(1);
    const v = validateModel(JSON.parse(JSON.stringify(m)));
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("すでにある画面は足さない。足すものが無ければモデルは変わらない", () => {
    const m = okModel(addSitemapScreens(base(), "sys_a", [{ kind: "screen", screenId: "scr_1" }]));
    const again = addSitemapScreens(m, "sys_a", [{ kind: "screen", screenId: "scr_1" }]);
    expect(again.ok && again.model).toBe(m);
  });

  it("あとから足すと、既存の遷移を重ねず、新しい分だけ足す", () => {
    let m = okModel(addSitemapScreens(base(), "sys_a", [{ kind: "screen", screenId: "scr_1" }]));
    m = okModel(addSitemapScreens(m, "sys_a", [{ kind: "screen", screenId: "scr_2" }]));
    expect(m.designs[0]!.transitions).toHaveLength(1);
    expect(designScreenName(m, m.designs[0]!.screens[0]!)).toBe("検索");
  });
});

describe("コマンド", () => {
  const withScreens = () => okModel(addSitemapScreens(base(), "sys_a", [{ kind: "builtin", builtin: "top" }, { kind: "screen", screenId: "scr_1" }, { kind: "screen", screenId: "scr_2" }, { kind: "screen", screenId: "scr_3" }]));
  const idOf = (m: UntieModel, screenId: string) => m.designs[0]!.screens.find((s) => s.source.kind === "screen" && s.source.screenId === screenId)!.id;

  it("addDesignScreens: 別のシステムの画面・存在しない画面・重複は失敗", () => {
    expectFail(addDesignScreens(base(), { systemId: "sys_a", screens: [{ source: { kind: "screen", screenId: "scr_5" } }], transitions: [] }), /別のシステム/);
    expectFail(addDesignScreens(base(), { systemId: "sys_a", screens: [{ source: { kind: "screen", screenId: "nothing" } }], transitions: [] }), /存在しません/);
    expectFail(addDesignScreens(base(), { systemId: "sys_a", screens: [{ source: { kind: "screen", screenId: "scr_1" } }, { source: { kind: "screen", screenId: "scr_1" } }], transitions: [] }), /すでに/);
    expectFail(addDesignScreens(base(), { systemId: "nothing", screens: [{ source: { kind: "builtin", builtin: "top" } }], transitions: [] }), /システムが存在しません/);
  });

  it("addDesignScreens: id を渡すとその id になり、遷移で指せる。ほかの設計と重なる id は失敗", () => {
    const r = okModel(addDesignScreens(base(), { systemId: "sys_a", screens: [{ id: "ds_x", source: { kind: "screen", screenId: "scr_1" } }, { id: "ds_y", source: { kind: "screen", screenId: "scr_2" } }], transitions: [{ from: "ds_x", to: "ds_y", via: "button" }] }));
    expect(r.designs[0]!.transitions[0]).toMatchObject({ from: "ds_x", to: "ds_y", via: "button" });
    expect(usedDesignIds(r).has("ds_x")).toBe(true);
    expectFail(addDesignScreens(r, { systemId: "sys_a", screens: [{ id: "ds_x", source: { kind: "builtin", builtin: "top" } }], transitions: [] }), /id/);
    // 別のシステムの設計で使われている id とも重ならない
    expectFail(addDesignScreens(r, { systemId: "sys_b", screens: [{ id: "ds_x", source: { kind: "builtin", builtin: "top" } }], transitions: [] }), /id がすでに使われています: ds_x/);
    // 遷移の id も設計をまたいで重ならない
    const withB = okModel(addDesignScreens(r, { systemId: "sys_b", screens: [{ id: "ds_z", source: { kind: "builtin", builtin: "top" } }, { id: "ds_w", source: { kind: "builtin", builtin: "signIn" } }], transitions: [] }));
    const tr = okModel(addTransition(withB, { systemId: "sys_a", from: "ds_y", to: "ds_x" }));
    expectFail(addDesignScreens(tr, { systemId: "sys_b", screens: [], transitions: [{ id: tr.designs[0]!.transitions[0]!.id, from: "ds_z", to: "ds_w" }] }), /id がすでに使われています/);
  });

  it("addDesignScreens: 不正な入力 (組み込みの種類・via・文言) と空の入力", () => {
    const badBuiltin = { systemId: "sys_a", screens: [{ source: { kind: "builtin", builtin: "nothing" } }], transitions: [] } as unknown as Parameters<typeof addDesignScreens>[1];
    expectFail(addDesignScreens(base(), badBuiltin), /組み込みの画面ではありません/);
    const m = withScreens();
    const [a, c] = [idOf(m, "scr_1"), idOf(m, "scr_3")];
    expectFail(addDesignScreens(m, { systemId: "sys_a", screens: [], transitions: [{ from: a, to: c, via: "swipe" as never }] }), /きっかけが正しくありません/);
    expectFail(addDesignScreens(m, { systemId: "sys_a", screens: [], transitions: [{ from: a, to: c, label: "あ".repeat(201) }] }), /200 文字/);
    const b = base();
    const same = addDesignScreens(b, { systemId: "sys_a", screens: [], transitions: [] });
    expect(same.ok && same.model).toBe(b);
    expect(b.designs).toEqual([]);
  });

  it("追加以外のコマンドは設計を作らず、設計が無ければ失敗。空の削除は元のモデルを返す", () => {
    const b = base();
    expectFail(removeDesignScreensById(b, { systemId: "sys_a", ids: ["ds_1"] }), /設計が存在しません/);
    expectFail(updateTransition(b, { systemId: "sys_a", id: "tr_1", patch: {} }), /設計が存在しません/);
    expectFail(removeTransition(b, { systemId: "sys_a", id: "tr_1" }), /設計が存在しません/);
    const r = removeDesignScreensById(b, { systemId: "sys_a", ids: [] });
    expect(r.ok && r.model).toBe(b);
  });

  it("screensWithDesign: view があるか、bindings が 1 つ以上ある画面だけ", () => {
    const s = [{ id: "a", source: { kind: "builtin" as const, builtin: "top" as const }, bindings: [] }, { id: "b", source: { kind: "builtin" as const, builtin: "signIn" as const }, bindings: [{ item: "x", databaseId: "d", table: "t", column: "c" }] }, { id: "c", source: { kind: "builtin" as const, builtin: "signUp" as const }, view: {} }];
    expect(screensWithDesign(s).map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("addDesignScreens: 遷移の両端が設計に無い・自分自身・重複は失敗", () => {
    const m = withScreens();
    const a = idOf(m, "scr_1");
    expectFail(addDesignScreens(m, { systemId: "sys_a", screens: [], transitions: [{ from: a, to: "ds_none" }] }), /サイトマップの画面/);
    expectFail(addDesignScreens(m, { systemId: "sys_a", screens: [], transitions: [{ from: a, to: a }] }), /同じ画面/);
    expectFail(addDesignScreens(m, { systemId: "sys_a", screens: [], transitions: [{ from: a, to: idOf(m, "scr_2") }] }), /すでに/);
  });

  it("addTransition / updateTransition / removeTransition", () => {
    let m = withScreens();
    const [a, c] = [idOf(m, "scr_1"), idOf(m, "scr_3")];
    expectFail(addTransition(m, { systemId: "sys_a", from: a, to: c, label: "あ".repeat(201) }), /遷移の文言は 200 文字/);
    const added = addTransition(m, { systemId: "sys_a", from: a, to: c, via: "row", label: " 開く " });
    if (!added.ok) throw new Error(added.reason);
    m = added.model;
    expect(m.designs[0]!.transitions.find((t) => t.id === added.id)).toMatchObject({ from: a, to: c, via: "row", label: "開く" });
    expectFail(addTransition(m, { systemId: "sys_a", from: a, to: c }), /すでに/);

    m = okModel(updateTransition(m, { systemId: "sys_a", id: added.id, patch: { via: "button", label: "確認へ" } }));
    expect(m.designs[0]!.transitions.find((t) => t.id === added.id)).toMatchObject({ via: "button", label: "確認へ" });
    m = okModel(updateTransition(m, { systemId: "sys_a", id: added.id, patch: { via: null, label: "" } }));
    const t = m.designs[0]!.transitions.find((x) => x.id === added.id)!;
    expect(t.via).toBeUndefined();
    expect("label" in t).toBe(false);
    expectFail(updateTransition(m, { systemId: "sys_a", id: "nothing", patch: {} }), /存在しません/);
    expectFail(updateTransition(m, { systemId: "sys_a", id: added.id, patch: { label: "あ".repeat(201) } }), /200 文字/);

    m = okModel(removeTransition(m, { systemId: "sys_a", id: added.id }));
    expect(m.designs[0]!.transitions.some((x) => x.id === added.id)).toBe(false);
    expectFail(removeTransition(m, { systemId: "sys_a", id: added.id }), /存在しません/);
  });

  it("removeDesignScreensById: 画面とそれを指す遷移・ナビの項目も消える", () => {
    let m = withScreens();
    const b = idOf(m, "scr_2");
    m = { ...m, designs: [{ ...m.designs[0]!, layout: { shell: "shell", navigation: [{ id: "nav_1", group: "予約", items: [{ screenId: b }] }] } }] };
    const r = removeDesignScreensById(m, { systemId: "sys_a", ids: [b] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.removed).toEqual([b]);
    const d = r.model.designs[0]!;
    expect(d.screens.some((s) => s.id === b)).toBe(false);
    expect(d.transitions.some((t) => t.from === b || t.to === b)).toBe(false);
    expect(d.layout.navigation[0]!.items).toEqual([]);
    expectFail(removeDesignScreensById(m, { systemId: "sys_a", ids: ["ds_none"] }), /画面がありません/);
  });
});
