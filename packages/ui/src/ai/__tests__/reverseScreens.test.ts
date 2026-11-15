// 段階 2 (画面) の下書きの組み立て (applyScreensDraft): システム・画面・遷移・ナビゲーション・使うデータベースを、すでにあるモデルに足す
import { describe, expect, it } from "vitest";
import { checkDesign } from "@untie/core/model/designCheck";
import { designScreenName } from "@untie/core/model/sitemap";
import { traceToActors } from "@untie/core/model/trace";
import { emptyModel, type UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import { applyDataImport } from "../reverseData";
import { applyScreensDraft, readScreensDraft, type ScreensDraft } from "../reverseScreens";
import { FIXTURE_DSL } from "./fixtures/reverseDraft";

const draft: ScreensDraft = {
  systems: [
    {
      name: "サイト",
      description: "お客様のサイト",
      screens: [{ name: "入力", description: "(src/Input.tsx)" }, { name: "確認" }, { name: "完了" }],
      transitions: [{ from: "入力", to: "確認", via: "afterSubmit" }, { from: "確認", to: "完了", via: "button", label: "送る" }],
    },
  ],
};
const nameOfScreens = (m: UntieModel) => m.elements.filter((e) => e.kind === "screen").map((e) => e.name);
const healthy = (m: UntieModel) => {
  expect(validateModel(JSON.parse(JSON.stringify(m))).ok).toBe(true);
  expect(traceToActors(m).problems.filter((p) => p.isBreak)).toEqual([]);
};

describe("applyScreensDraft", () => {
  it("システムと画面を足し、設計の画面・遷移・ナビゲーション (遷移から) を作る。操作はまだ結ばない", () => {
    const r = applyScreensDraft(emptyModel("m"), draft);
    expect(r.added).toEqual({ systems: 1, screens: 3, transitions: 2 });
    expect(nameOfScreens(r.model)).toEqual(["入力", "確認", "完了"]);
    const d = r.model.designs[0]!;
    expect(d.screens.map((s) => designScreenName(r.model, s))).toEqual(["入力", "確認", "完了"]);
    expect(d.transitions).toHaveLength(2);
    expect(d.layout.navigation.flatMap((g) => g.items)).toHaveLength(3);
    expect(r.model.relations).toEqual([]);
    healthy(r.model);
  });

  it("もう一度足しても、システム・画面・遷移・設計の画面は二重にならない", () => {
    const once = applyScreensDraft(emptyModel("m"), draft).model;
    const twice = applyScreensDraft(once, draft);
    expect(twice.added).toEqual({ systems: 0, screens: 0, transitions: 0 });
    expect(twice.model.elements).toHaveLength(once.elements.length);
    expect(twice.model.designs[0]!.screens).toHaveLength(3);
    expect(twice.model.designs[0]!.transitions).toHaveLength(2);
    expect(twice.model.designs[0]!.layout.navigation).toEqual(once.designs[0]!.layout.navigation);
  });

  it("AI のメニュー (navigation) があればそれで作り、書かれなかった画面は「その他」へ。あとで足す画面は、すでにあるメニューを変えず「その他」へ", () => {
    const withNav: ScreensDraft = { systems: [{ ...draft.systems[0]!, navigation: [{ group: "注文", screens: ["入力", "確認"] }] }] };
    const r = applyScreensDraft(emptyModel("m"), withNav);
    expect(r.model.designs[0]!.layout.navigation.map((g) => [g.group, g.items.length])).toEqual([["注文", 2], ["その他", 1]]);
    const more = applyScreensDraft(r.model, { systems: [{ ...draft.systems[0]!, screens: [...draft.systems[0]!.screens, { name: "履歴" }] }] });
    expect(more.added.screens).toBe(1);
    const nav = more.model.designs[0]!.layout.navigation;
    expect(nav.map((g) => [g.group, g.items.length])).toEqual([["注文", 2], ["その他", 2]]);
    expect(nav.map((g) => g.id)).toEqual(r.model.designs[0]!.layout.navigation.map((g) => g.id));
  });

  it("画面の無いシステムは作らず、AI に直してもらう問題にする。見つからない画面の遷移は落として問題にする", () => {
    const r = applyScreensDraft(emptyModel("m"), { systems: [{ name: "空のシステム", screens: [] }, { ...draft.systems[0]!, transitions: [{ from: "入力", to: "無い画面" }] }] });
    expect(r.model.elements.filter((e) => e.kind === "system").map((e) => e.name)).toEqual(["サイト"]);
    expect(r.issues.some((i) => /空のシステム/.test(i))).toBe(true);
    expect(r.issues.some((i) => /無い画面/.test(i))).toBe(true);
  });

  it("使うデータベース: AI の答え、無ければデータベースが 1 つならそれ。複数で答えが無ければ問題にする。すでに決まっているものは変えない", () => {
    const one = applyDataImport(emptyModel("m"), { name: "DB1", dsl: FIXTURE_DSL }).model;
    const r = applyScreensDraft(one, draft);
    expect(r.model.designs[0]!.databaseIds).toEqual([one.databases[0]!.id]);
    const two = applyDataImport(one, { name: "DB2", dsl: FIXTURE_DSL }).model;
    const none = applyScreensDraft(two, draft);
    expect(none.model.designs[0]!.databaseIds).toEqual([]);
    expect(none.issues.some((i) => /使うデータベースが決まっていません/.test(i))).toBe(true);
    const asked = applyScreensDraft(two, { systems: [{ ...draft.systems[0]!, databases: ["DB2"] }] });
    expect(asked.model.designs[0]!.databaseIds).toEqual([two.databases[1]!.id]);
    expect(checkDesign(asked.model, asked.model.designs[0]!.systemId).problems).toEqual([]);
    // すでに決めてあるデータベースは、答えが違っても変えない
    const again = applyScreensDraft(asked.model, { systems: [{ ...draft.systems[0]!, databases: ["DB1"] }] });
    expect(again.model.designs[0]!.databaseIds).toEqual([two.databases[1]!.id]);
  });

  it("操作に結ばれていない画面と、画面しか持たないシステムは、検証に通る (途中の状態)", () => {
    const r = applyScreensDraft(emptyModel("m"), draft);
    healthy(r.model);
    // 設計の検証にエラーは出ない (設計を作ると、空の既定のデータベースもできる。情報がまだ無いので、対応していない情報も無い)
    expect(checkDesign(r.model, r.model.designs[0]!.systemId).problems).toEqual([]);
    expect(r.model.databases.map((d) => d.dsl)).toEqual([""]);
  });
});

describe("readScreensDraft", () => {
  it("形が違えば null。名前の無いシステム・画面は読み飛ばし、使えない値は落とす", () => {
    expect(readScreensDraft(null)).toBeNull();
    expect(readScreensDraft({ systems: "x" })).toBeNull();
    const d = readScreensDraft({ systems: [{ name: "S", screens: [{ name: "A", description: 1 }, { nameless: true }], transitions: [{ from: "A" }], databases: ["D", 3], navigation: [{ group: "G", screens: ["A", 1] }] }, { screens: [] }] })!;
    expect(d.systems).toEqual([{ name: "S", screens: [{ name: "A" }], databases: ["D"], navigation: [{ group: "G", screens: ["A"] }] }]);
  });

  it("綴りの違い (全角半角・空白・大文字小文字) を同じ名前とみなす: 「ＥＣ サイト」「注文 一覧」「ｉｄ発行」が、すでにある「EC サイト」「注文一覧」「ID 発行」と二重にならず、もとの名前は書き換わらない。遷移の名前も合う", () => {
    const first = applyScreensDraft(emptyModel("m"), { systems: [{ name: "EC サイト", screens: [{ name: "注文一覧" }, { name: "ID 発行" }] }] });
    const r = applyScreensDraft(first.model, {
      systems: [{ name: "ＥＣ サイト", screens: [{ name: "注文 一覧" }, { name: "ｉｄ発行" }, { name: "注文詳細" }], transitions: [{ from: "注文 一覧", to: "注文詳細", via: "row" }], navigation: [{ group: "注文", screens: ["注文 一覧", "注文詳細"] }] }],
    });
    expect(r.added).toEqual({ systems: 0, screens: 1, transitions: 1 });
    expect(r.model.elements.filter((e) => e.kind === "system").map((e) => e.name)).toEqual(["EC サイト"]);
    expect(nameOfScreens(r.model)).toEqual(["注文一覧", "ID 発行", "注文詳細"]);
    // 画面 UI を作る対象の名前は、モデルにある名前
    expect(r.named).toEqual([{ system: "EC サイト", screen: "注文一覧" }, { system: "EC サイト", screen: "ID 発行" }, { system: "EC サイト", screen: "注文詳細" }]);
    expect(r.warnings.filter((w) => /見つかりません/.test(w))).toEqual([]);
    healthy(r.model);
  });

  it("同じ名前のアクター (外部アクター) がいるところへシステムを作るときは、人とは別のシステムとして作り、警告する", () => {
    const first = applyScreensDraft(emptyModel("m"), { systems: [{ name: "別", screens: [{ name: "x" }] }] }).model;
    // アクター「管理」を足したモデル
    const added = { ...first, elements: [...first.elements, { id: "act_1", kind: "actor", name: "管理", description: "" } as never] };
    const r = applyScreensDraft(added, { systems: [{ name: "管理", screens: [{ name: "管理トップ" }] }] });
    expect(r.model.elements.filter((e) => e.kind === "system" && e.name === "管理")).toHaveLength(1);
    expect(r.model.elements.filter((e) => e.kind === "actor" && e.name === "管理")).toHaveLength(1);
    expect(r.warnings.some((w) => /同じ名前のアクター/.test(w))).toBe(true);
  });
});
