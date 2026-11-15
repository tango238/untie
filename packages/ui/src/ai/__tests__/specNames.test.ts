// buildModelFromSpec の突き合わせ: 土台ありの組み立てで、名前だけの突き合わせが別の業務・別の種類の要素を取り違えないこと、
// 綴りの違い (全角半角・空白・大文字小文字) を同じ名前とみなすこと、土台の画面を下書きから指せること。
import { describe, expect, it } from "vitest";
import { validateModel } from "@untie/core/model/validate";
import type { Element, UntieModel } from "@untie/core/model/types";
import { buildModelFromSpec, nameKey, type ModelSpec } from "../spec";

const byName = (m: UntieModel, kind: string, name: string): Element[] => m.elements.filter((e) => e.kind === kind && e.name === name);
const one = (m: UntieModel, kind: string, name: string): Element => {
  const found = byName(m, kind, name);
  expect(found, `${kind}「${name}」`).toHaveLength(1);
  return found[0]!;
};
const relations = (m: UntieModel, kind: string, sourceId?: string) => m.relations.filter((r) => r.kind === kind && (sourceId === undefined || r.sourceId === sourceId));
const valid = (m: UntieModel) => expect(validateModel(JSON.parse(JSON.stringify(m))).ok).toBe(true);

/** 1 つ目の業務: 予約 (状態「予約の状態/確定」・操作「登録する」・作業「受け付ける」・画面「一覧」) */
const first: ModelSpec = {
  system_name: "小さな旅館",
  actors: [{ name: "フロント係" }],
  systems: [{ name: "予約サイト" }],
  informations: [{ name: "予約" }],
  state_groups: [{ name: "予約の状態", states: [{ name: "仮予約" }, { name: "確定" }] }],
  businesses: [
    {
      name: "予約受付",
      main_actors: ["フロント係"],
      activities: [{ name: "受け付ける", performers: ["フロント係"], usecases: [{ name: "登録する", writes: ["予約"], to_states: ["確定"] }] }],
    },
  ],
  screens: [{ name: "予約一覧", system: "予約サイト", usecase: "登録する" }],
};
const baseModel = () => buildModelFromSpec(first).model;

describe("状態は、グループと名前の組で突き合わせる", () => {
  it("土台の「予約の状態/確定」があるところへ、「請求の状態/確定」を出すと、請求の状態が作られ、請求の操作は請求の状態に結ばれる", () => {
    const second: ModelSpec = {
      system_name: "x",
      actors: [{ name: "経理係" }],
      systems: [{ name: "予約サイト" }],
      informations: [{ name: "請求" }],
      state_groups: [{ name: "請求の状態", states: [{ name: "未請求" }, { name: "確定" }] }],
      businesses: [{ name: "請求", main_actors: ["経理係"], activities: [{ name: "請求を出す", performers: ["経理係"], usecases: [{ name: "請求を確定する", writes: ["請求"], from_states: ["未請求"], to_states: ["確定"] }] }] }],
    };
    const r = buildModelFromSpec(second, { base: baseModel() });
    const states = r.model.elements.filter((e) => e.kind === "state" && e.name === "確定");
    expect(states.map((s) => (s.kind === "state" ? s.group : ""))).toEqual(["予約の状態", "請求の状態"]);
    const billing = states.find((s) => s.kind === "state" && s.group === "請求の状態")!;
    const uc = one(r.model, "usecase", "請求を確定する");
    expect(relations(r.model, "usecaseState", uc.id).map((x) => x.targetId)).toEqual([billing.id]);
    // 土台の操作の実行後の状態は、予約の「確定」のまま
    const reserve = states.find((s) => s.kind === "state" && s.group === "予約の状態")!;
    expect(relations(r.model, "usecaseState", one(r.model, "usecase", "登録する").id).map((x) => x.targetId)).toEqual([reserve.id]);
    valid(r.model);
  });

  it("同じグループの同じ名前の状態は、土台のものを使う (二重にならない)", () => {
    const r = buildModelFromSpec(first, { base: baseModel() });
    expect(r.model.elements.filter((e) => e.kind === "state")).toHaveLength(2);
  });
});

describe("操作は、同じ作業か同じ画面のときだけ、土台の操作と同じものとみなす", () => {
  const second = (extra: Partial<ModelSpec> = {}): ModelSpec => ({
    system_name: "x",
    actors: [{ name: "フロント係" }, { name: "経理係" }],
    systems: [{ name: "予約サイト" }],
    informations: [{ name: "請求" }],
    businesses: [{ name: "請求", main_actors: ["経理係"], activities: [{ name: "請求を出す", performers: ["経理係"], usecases: [{ name: "登録する", writes: ["請求"] }] }] }],
    ...extra,
  });

  it("2 つ目の業務の「登録する」は、1 つ目の業務の「登録する」に合流せず、新しい操作として作られ、名前が重なることを警告する", () => {
    const base = baseModel();
    const r = buildModelFromSpec(second(), { base });
    const ucs = byName(r.model, "usecase", "登録する");
    expect(ucs).toHaveLength(2);
    const newer = ucs.find((u) => !base.elements.some((b) => b.id === u.id))!;
    // 請求の作業が、新しい操作を使っている。土台の操作は 1 つ目の作業のまま
    const act = one(r.model, "activity", "請求を出す");
    expect(relations(r.model, "activityUsecase", act.id).map((x) => x.targetId)).toEqual([newer.id]);
    expect(relations(r.model, "activityUsecase", one(r.model, "activity", "受け付ける").id)).toHaveLength(1);
    expect(r.warnings.some((w) => /「登録する」/.test(w) && /別の操作/.test(w) && /名前が重なります/.test(w))).toBe(true);
    // 土台の操作に、請求の情報は付かない
    const info = one(r.model, "information", "請求");
    expect(relations(r.model, "usecaseInformation", ucs.find((u) => u !== newer)!.id).some((x) => x.targetId === info.id)).toBe(false);
    valid(r.model);
  });

  it("同じ業務・同じ活動の同じ名前の作業にある、同じ名前の操作は、土台の操作と同じもの (作り直さない)", () => {
    const again: ModelSpec = { ...first, state_groups: undefined, businesses: [{ name: "予約受付", activities: [{ name: "受け付ける", usecases: [{ name: "登録する", reads: ["予約"] }] }] }], screens: undefined };
    const r = buildModelFromSpec(again, { base: baseModel() });
    expect(byName(r.model, "usecase", "登録する")).toHaveLength(1);
    expect(r.warnings.filter((w) => /別の操作/.test(w))).toEqual([]);
  });

  it("同じ画面を使う、同じ名前の操作 (screens の usecase と、土台の画面を使う土台の操作の名前が同じ) も、同じもの", () => {
    const viaScreen: ModelSpec = { system_name: "x", systems: [{ name: "予約サイト" }], businesses: [], screens: [{ name: "予約一覧", system: "予約サイト", usecase: "登録する" }] };
    const r = buildModelFromSpec(viaScreen, { base: baseModel() });
    expect(byName(r.model, "usecase", "登録する")).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });

  it("別の作業にある同じ名前の操作が土台の画面を宣言していても、その画面を使う土台の操作と同じ名前なら、画面で同じものにする", () => {
    const r = buildModelFromSpec(second({ screens: [{ name: "予約一覧", system: "予約サイト", usecase: "登録する" }] }), { base: baseModel() });
    // 請求の「登録する」は、土台の「予約一覧」を使う土台の「登録する」と同じ操作として扱われる
    expect(byName(r.model, "usecase", "登録する")).toHaveLength(1);
  });

  it("土台なしの組み立て: 同じ名前の操作は、どの作業にあっても同じもの (これまでどおり)", () => {
    const r = buildModelFromSpec({
      system_name: "x",
      actors: [{ name: "A" }],
      businesses: [{ name: "b1", main_actors: ["A"], activities: [{ name: "a1", performers: ["A"], usecases: [{ name: "登録する" }] }, { name: "a2", performers: ["A"], usecases: [{ name: "登録する" }] }] }],
    });
    expect(byName(r.model, "usecase", "登録する")).toHaveLength(1);
  });
});

describe("課題の対象は、今回足した要素を先に探す", () => {
  it("新しい業務の「受け付ける」に付き、土台の別の業務の同じ名前の作業には付かない", () => {
    const second: ModelSpec = {
      system_name: "x",
      actors: [{ name: "経理係" }],
      businesses: [{ name: "請求", main_actors: ["経理係"], activities: [{ name: "受け付ける", performers: ["経理係"] }] }],
      issues: [{ name: "遅い", targets: ["受け付ける"] }],
    };
    const base = baseModel();
    const r = buildModelFromSpec(second, { base });
    const acts = byName(r.model, "activity", "受け付ける");
    expect(acts).toHaveLength(2);
    const added = acts.find((a) => !base.elements.some((b) => b.id === a.id))!;
    const issue = one(r.model, "issue", "遅い");
    expect(issue.kind === "issue" ? issue.targetIds : []).toEqual([added.id]);
  });
});

describe("同じ名前のアクターとシステム", () => {
  const spec: ModelSpec = {
    system_name: "x",
    actors: [{ name: "管理" }],
    systems: [{ name: "管理" }],
    informations: [{ name: "帳簿" }],
    businesses: [{ name: "経理", main_actors: ["管理"], activities: [{ name: "記帳する", performers: ["管理"], usecases: [{ name: "帳簿に書く", writes: ["帳簿"], targets: ["管理"] }] }] }],
    screens: [{ name: "管理画面", system: "管理", usecase: "帳簿に書く" }],
  };
  it("システムが人と別に作られ、作業の担当は人、操作の対象・画面の属するシステムはシステムに向く", () => {
    const r = buildModelFromSpec(spec);
    const person = one(r.model, "actor", "管理");
    const system = one(r.model, "system", "管理");
    expect(person.id).not.toBe(system.id);
    const act = one(r.model, "activity", "記帳する");
    expect(relations(r.model, "actorActivity").map((x) => [x.sourceId, x.targetId])).toEqual([[person.id, act.id]]);
    expect(relations(r.model, "actorBusiness").map((x) => x.sourceId)).toEqual([person.id]);
    const screen = one(r.model, "screen", "管理画面");
    expect(screen.kind === "screen" ? screen.systemId : "").toBe(system.id);
    valid(r.model);
  });
  it("土台にいる人と同じ名前のシステムを足しても、システムは作られ、参照は種類から探す", () => {
    const base = buildModelFromSpec({ system_name: "x", actors: [{ name: "管理" }], businesses: [] }).model;
    const r = buildModelFromSpec({ ...spec, actors: [] }, { base });
    expect(byName(r.model, "system", "管理")).toHaveLength(1);
    const uc = one(r.model, "usecase", "帳簿に書く");
    // 操作の対象は画面 (screens の usecase) か、システム。人には向かない
    const targets = relations(r.model, "usecaseSystem", uc.id).map((x) => x.targetId);
    expect(targets.every((id) => r.model.elements.find((e) => e.id === id)?.kind !== "actor")).toBe(true);
  });
});

describe("綴りの違いを同じ名前とみなす", () => {
  it("nameKey: NFKC・小文字・空白 (全角・半角) の削除", () => {
    expect(nameKey("ＥＣ サイト")).toBe(nameKey("EC サイト"));
    expect(nameKey("注文　一覧")).toBe(nameKey("注文一覧"));
    expect(nameKey("ｉｄ発行")).toBe(nameKey("ID 発行"));
    expect(nameKey("注文一覧")).not.toBe(nameKey("注文詳細"));
  });
  it("土台の「EC サイト」「注文一覧」に、「ＥＣ サイト」「注文 一覧」を出しても、二重に作られない。土台の名前は書き換えない", () => {
    const base = buildModelFromSpec({ system_name: "x", systems: [{ name: "EC サイト" }], businesses: [], screens: [{ name: "注文一覧", system: "EC サイト" }] }).model;
    const r = buildModelFromSpec({ system_name: "x", systems: [{ name: "ＥＣ サイト" }], businesses: [], screens: [{ name: "注文 一覧", system: "ＥＣ サイト" }] }, { base });
    expect(r.model.elements.filter((e) => e.kind === "system").map((e) => e.name)).toEqual(["EC サイト"]);
    expect(r.model.elements.filter((e) => e.kind === "screen").map((e) => e.name)).toEqual(["注文一覧"]);
    expect(r.added).toEqual({});
  });
  it("土台なしでも、綴りの揺れた参照が結ばれる (「プロンプトから作成」で変わる点: 全角半角・空白・大文字小文字の違いは同じ名前)", () => {
    const r = buildModelFromSpec({
      system_name: "x",
      actors: [{ name: "Ａさん" }],
      informations: [{ name: "注文 書" }],
      businesses: [{ name: "b", main_actors: ["Aさん"], activities: [{ name: "a", performers: ["a さん"], usecases: [{ name: "u", writes: ["注文書"] }] }] }],
    });
    expect(r.warnings).toEqual([]);
    expect(relations(r.model, "actorBusiness")).toHaveLength(1);
    expect(relations(r.model, "usecaseInformation")).toHaveLength(1);
  });
});

describe("土台の画面を、下書きから指す", () => {
  /** 2 つのシステムに、同じ名前でない画面がある土台 */
  const twoSystems = (): UntieModel =>
    buildModelFromSpec({
      system_name: "x",
      systems: [{ name: "管理サイト" }, { name: "顧客サイト" }],
      businesses: [],
      screens: [
        { name: "注文一覧", system: "管理サイト" },
        { name: "マイページ", system: "顧客サイト" },
      ],
    }).model;
  const withUsecase = (screens: ModelSpec["screens"], target?: string): ModelSpec => ({
    system_name: "x",
    actors: [{ name: "担当" }],
    systems: [{ name: "管理サイト" }, { name: "顧客サイト" }],
    informations: [{ name: "注文" }],
    businesses: [{ name: "注文管理", main_actors: ["担当"], activities: [{ name: "注文を見る", performers: ["担当"], usecases: [{ name: "注文を一覧する", reads: ["注文"], ...(target ? { targets: [target] } : {}) }] }] }],
    screens,
  });

  it("(a) システムが 2 つ以上あっても、system を書かない画面が、土台にある同じ名前の画面 (1 つのシステムだけ) に結ばれる", () => {
    const r = buildModelFromSpec(withUsecase([{ name: "注文一覧", usecase: "注文を一覧する" }]), { base: twoSystems() });
    expect(r.warnings.some((w) => /属するシステムが決まらない/.test(w))).toBe(false);
    const screen = one(r.model, "screen", "注文一覧");
    expect(relations(r.model, "usecaseScreen").map((x) => [x.sourceId, x.targetId])).toEqual([[one(r.model, "usecase", "注文を一覧する").id, screen.id]]);
    expect(r.model.elements.filter((e) => e.kind === "screen")).toHaveLength(2);
    valid(r.model);
  });

  it("(a) 同じ名前の画面が 2 つのシステムにあるときは、決められないままで、新しく作らず警告する (これまでどおり)", () => {
    const base = buildModelFromSpec({ system_name: "x", systems: [{ name: "管理サイト" }, { name: "顧客サイト" }], businesses: [], screens: [{ name: "一覧", system: "管理サイト" }, { name: "一覧", system: "顧客サイト" }] }).model;
    const r = buildModelFromSpec(withUsecase([{ name: "一覧", usecase: "注文を一覧する" }]), { base });
    expect(r.warnings.some((w) => /属するシステムが決まらない/.test(w))).toBe(true);
    expect(r.model.elements.filter((e) => e.kind === "screen")).toHaveLength(2);
  });

  it("(b) 操作の targets に、土台にある画面の名前だけを書いても、その画面を使う操作として結ばれる", () => {
    const r = buildModelFromSpec(withUsecase(undefined, "注文一覧"), { base: twoSystems() });
    expect(r.warnings.some((w) => /が見つかりません/.test(w))).toBe(false);
    const uc = one(r.model, "usecase", "注文を一覧する");
    const screen = one(r.model, "screen", "注文一覧");
    expect(relations(r.model, "usecaseScreen", uc.id).map((x) => x.targetId)).toEqual([screen.id]);
    expect(r.model.elements.filter((e) => e.kind === "screen")).toHaveLength(2);
    valid(r.model);
  });

  it("(b) 同じ名前の画面が複数のシステムにあるときは、操作の対象のシステムと同じ画面だけに結ぶ (決まらなければ警告)", () => {
    const base = buildModelFromSpec({ system_name: "x", systems: [{ name: "管理サイト" }, { name: "顧客サイト" }], businesses: [], screens: [{ name: "一覧", system: "管理サイト" }, { name: "一覧", system: "顧客サイト" }] }).model;
    const r = buildModelFromSpec(withUsecase(undefined, "一覧"), { base });
    expect(relations(r.model, "usecaseScreen")).toHaveLength(0);
    expect(r.warnings.some((w) => /同じ名前の画面が複数/.test(w))).toBe(true);
  });
});

describe("綴りの違うだけの名前: 定義する側は別の要素、参照する側は完全に同じ名前 → 鍵 (レビューの指摘の再現)", () => {
  const spread = (s: Partial<ModelSpec>): ModelSpec => ({ system_name: "x", businesses: [], ...s });

  it("定義する側: 綴りだけが違う名前 (Order・order、工程①・工程1、㈱取引先・(株)取引先、店長・店 長、在庫管理・在庫 管理) は、別の要素として作り、説明も捨てない。警告も出さない", () => {
    const r = buildModelFromSpec(
      spread({
        informations: [{ name: "Order", description: "受注" }, { name: "order", description: "発注" }],
        external_actors: [{ name: "㈱取引先", description: "A" }, { name: "(株)取引先", description: "B" }],
        actors: [{ name: "店長", description: "C" }, { name: "店 長", description: "D" }],
        systems: [{ name: "在庫管理", description: "E" }, { name: "在庫 管理", description: "F" }],
        businesses: [{ name: "業務", activities: [{ name: "工程①", description: "G" }, { name: "工程1", description: "H" }] }],
      }),
    );
    expect(r.warnings).toEqual([]);
    for (const [kind, names] of [["information", ["Order", "order"]], ["externalActor", ["㈱取引先", "(株)取引先"]], ["actor", ["店長", "店 長"]], ["system", ["在庫管理", "在庫 管理"]], ["activity", ["工程①", "工程1"]]] as const) {
      for (const n of names) expect(byName(r.model, kind, n), `${kind}「${n}」`).toHaveLength(1);
    }
    expect((one(r.model, "information", "order") as { description?: string }).description).toBe("発注");
    // もとの名前が完全に同じ (前後の空白だけ違う) ときは、同じ要素
    const same = buildModelFromSpec(spread({ informations: [{ name: "Order" }, { name: " Order " }] }));
    expect(byName(same.model, "information", "Order")).toHaveLength(1);
  });

  it("参照する側: 完全に同じ名前を先に探し、無ければ鍵で 1 つに決まるときだけ結び、「『Ａさん』は『Aさん』として扱いました」を notices に残す (warnings にはしない)", () => {
    const r = buildModelFromSpec(
      spread({
        actors: [{ name: "Aさん" }],
        informations: [{ name: "Order" }, { name: "order" }, { name: "請求" }],
        businesses: [{ name: "業務", main_actors: ["Aさん"], activities: [{ name: "作業", performers: ["Ａさん"], usecases: [{ name: "操作", informations: ["order", "ＯＲＤＥＲ", "請求"] }] }] }],
      }),
    );
    const act = one(r.model, "activity", "作業");
    const uc = one(r.model, "usecase", "操作");
    // 担当は鍵で結ぶ
    expect(relations(r.model, "actorActivity", one(r.model, "actor", "Aさん").id).map((x) => x.targetId)).toEqual([act.id]);
    expect(r.notices).toEqual(["『Ａさん』は『Aさん』として扱いました"]);
    // 情報: 「order」は完全に同じ名前の order に、「ＯＲＤＥＲ」は Order・order の 2 つに当たるので結ばず、警告する。「請求」はそのまま
    expect(relations(r.model, "usecaseInformation", uc.id).map((x) => x.targetId).sort()).toEqual([one(r.model, "information", "order").id, one(r.model, "information", "請求").id].sort());
    expect(r.warnings).toEqual(["『ＯＲＤＥＲ』に当たる候補が複数あります (Order・order)。名前を揃えてください"]);
  });

  it("土台ありの突き合わせ: 完全に同じ名前 → 鍵 (1 つに決まるときだけ。結んだら notices に残す)。土台の要素は書き換えず、新しい要素は作らない", () => {
    const base = buildModelFromSpec(spread({ actors: [{ name: "Aさん", description: "もとの説明" }], systems: [{ name: "在庫管理" }], informations: [{ name: "Order" }, { name: "order" }] })).model;
    const r = buildModelFromSpec(
      spread({ actors: [{ name: "Ａさん", description: "新しい説明" }], systems: [{ name: "在庫 管理" }], informations: [{ name: "Order" }, { name: "ORDER" }] }),
      { base },
    );
    expect(r.model.elements.filter((e) => e.kind === "actor")).toHaveLength(1);
    expect(r.model.elements.filter((e) => e.kind === "system")).toHaveLength(1);
    expect((one(r.model, "actor", "Aさん") as { description?: string }).description).toBe("もとの説明");
    expect(r.notices).toEqual(expect.arrayContaining(["『Ａさん』は『Aさん』として扱いました", "『在庫 管理』は『在庫管理』として扱いました"]));
    // 「Order」は完全に同じ名前なので notices には残らない。「ORDER」は土台の 2 つに当たるので、結ばず警告する (別の要素として作る)
    expect(r.notices.some((n) => n.includes("『Order』"))).toBe(false);
    expect(r.warnings).toEqual(["『ORDER』に当たる候補が複数あります (Order・order)。名前を揃えてください"]);
    valid(r.model);
  });
});

describe("状態のまとまり (グループ) の名前が変わったとき", () => {
  const states = [{ name: "仮予約" }, { name: "確定" }];
  const withGroup = (name: string): ModelSpec => ({ system_name: "x", businesses: [], state_groups: [{ name, states }] });

  it("1 回目「予約の状態」、2 回目「予約ステータス」: 状態は 4 つになるが、「すでにある『予約の状態』と同じ名前です」と警告する (出し直しを求める warnings)", () => {
    const base = buildModelFromSpec(withGroup("予約の状態")).model;
    const r = buildModelFromSpec(withGroup("予約ステータス"), { base });
    expect(r.model.elements.filter((e) => e.kind === "state")).toHaveLength(4);
    expect(r.warnings).toEqual(["状態『仮予約』『確定』は、すでにある『予約の状態』と同じ名前です。同じものなら、まとまりの名前を揃えてください"]);
  });

  it("同じまとまりの名前なら、二重にならず、警告もない。綴りの揺れだけのまとまりの名前は、土台のまとまりとして扱い、notices に残す", () => {
    const base = buildModelFromSpec(withGroup("予約の状態")).model;
    const same = buildModelFromSpec(withGroup("予約の状態"), { base });
    expect(same.model.elements.filter((e) => e.kind === "state")).toHaveLength(2);
    expect(same.warnings).toEqual([]);
    const fuzzy = buildModelFromSpec(withGroup("予約の 状態"), { base });
    expect(fuzzy.model.elements.filter((e) => e.kind === "state")).toHaveLength(2);
    expect(fuzzy.warnings).toEqual([]);
    expect(fuzzy.notices).toEqual(["『予約の 状態』は『予約の状態』として扱いました"]);
  });

  it("名前が重ならない別のまとまり (「請求の状態/請求済み」) は警告しない。1 つだけ重なる程度でも警告しない", () => {
    const base = buildModelFromSpec(withGroup("予約の状態")).model;
    const other = buildModelFromSpec({ system_name: "x", businesses: [], state_groups: [{ name: "請求の状態", states: [{ name: "未請求" }, { name: "確定" }] }] }, { base });
    expect(other.warnings).toEqual([]);
  });
});
