import { describe, expect, it } from "vitest";
import schemaJson from "../../../../../schema/untie.schema.json";
import {
  addBoard,
  addElement,
  renameBoard,
  updateElement,
} from "../commands";
import {
  ANALYSIS_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  GROUP_MAX_LENGTH,
  LINK_TITLE_MAX_LENGTH,
  LINK_URL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  textLength,
  truncateText,
  VALUE_MAX_LENGTH,
  VERIFICATION_MAX_LENGTH,
  TRIGGER_NOTE_MAX_LENGTH,
  DSL_MAX_LENGTH,
  ENGLISH_MAX_LENGTH,
  EXCLUDED_KEY_MAX_LENGTH,
  LIMITS,
} from "../limits";
import { repairModel } from "../repair";
import { truncateElementStrings, truncateModelStrings } from "../truncate";
import { validateModel } from "../validate";
import { emptyModel, type Element, type UntieModel } from "../types";
import { expectFail, okModel } from "./helpers";

interface SchemaNode {
  maxLength?: number;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}
const schema = schemaJson as unknown as { $defs: Record<string, SchemaNode> };
const def = (name: string) => schema.$defs[name];

describe("limits.ts はスキーマの maxLength と一致する", () => {
  it("名前・説明・グループ・値・分析・リンク", () => {
    expect(NAME_MAX_LENGTH).toBe(def("name").maxLength);
    expect(ENGLISH_MAX_LENGTH).toBe(def("englishName").maxLength);
    expect(EXCLUDED_KEY_MAX_LENGTH).toBe(def("domainModel").properties!.excluded!.items!.maxLength);
    expect(GROUP_MAX_LENGTH).toBe(def("aggregate").properties!.stateGroup!.maxLength);
    expect(DESCRIPTION_MAX_LENGTH).toBe(def("description").maxLength);
    expect(GROUP_MAX_LENGTH).toBe(def("state").properties!.group.maxLength);
    expect(VALUE_MAX_LENGTH).toBe(def("variation").properties!.values.items!.maxLength);
    for (const key of ["phenomenon", "location", "cause", "impact"]) {
      expect(ANALYSIS_MAX_LENGTH).toBe(def("issueAnalysis").properties![key].maxLength);
    }
    expect(LINK_TITLE_MAX_LENGTH).toBe(def("link").properties!.title.maxLength);
    expect(LINK_URL_MAX_LENGTH).toBe(def("link").properties!.url.maxLength);
    expect(VERIFICATION_MAX_LENGTH).toBe(def("nfr").properties!.verification.maxLength);
    expect(TRIGGER_NOTE_MAX_LENGTH).toBe(def("activity").properties!.triggerNote.maxLength);
    expect(DSL_MAX_LENGTH).toBe(def("database").properties!.dsl.maxLength);
    expect(LIMITS.personaHandle.max).toBe(def("persona").properties!.handle.maxLength);
    expect(LIMITS.personaAttributes.max).toBe(def("persona").properties!.attributes.maxLength);
    expect(LIMITS.personaBackground.max).toBe(def("persona").properties!.background.maxLength);
    expect(LIMITS.personaGoals.max).toBe(def("persona").properties!.goals.maxLength);
    expect(LIMITS.personaNotes.max).toBe(def("persona").properties!.notes.maxLength);
  });

  it("スキーマに maxLength を足したら、ここも足すこと (文字列の上限を持つ項目はこれだけ。id は自動で振るので上限の検査は要らない)", () => {
    const found: string[] = [];
    const walk = (node: SchemaNode | undefined, path: string) => {
      if (!node) return;
      if (node.maxLength !== undefined) found.push(path);
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
      walk(node.items, `${path}[]`);
    };
    for (const [name, node] of Object.entries(schema.$defs)) walk(node, name);
    expect(found.sort()).toEqual(
      [
        "id",
        "name",
        "description",
        "state.group",
        "variation.values[]",
        "issueAnalysis.phenomenon",
        "issueAnalysis.location",
        "issueAnalysis.cause",
        "issueAnalysis.impact",
        "link.title",
        "link.url",
        "nfr.verification",
        "activity.triggerNote",
        "database.dsl",
        "persona.handle",
        "persona.attributes",
        "persona.background",
        "persona.goals",
        "persona.notes",
        "eventTiming.note",
        // ドメインモデル (0.6.0)。名前・説明の型 ($ref) を使う項目は name / description に含まれる
        "englishName",
        "domainModel.excluded[]",
        "aggregate.stateGroup",
      ].sort(),
    );
  });

  it("上限ちょうどの文字列はスキーマの検証に通り、1 文字超えると通らない", () => {
    const at = (n: number) => "あ".repeat(n);
    const withName = (name: string): UntieModel => ({ ...emptyModel(), meta: { name } });
    expect(validateModel(withName(at(NAME_MAX_LENGTH))).ok).toBe(true);
    expect(validateModel(withName(at(NAME_MAX_LENGTH + 1))).ok).toBe(false);
    const withDescription = (description: string): UntieModel => ({ ...emptyModel(), meta: { name: "x", description } });
    expect(validateModel(withDescription(at(DESCRIPTION_MAX_LENGTH))).ok).toBe(true);
    expect(validateModel(withDescription(at(DESCRIPTION_MAX_LENGTH + 1))).ok).toBe(false);
  });

  it("文字数はコードポイントで数える (サロゲートペアは 1 文字。スキーマの検証と同じ)", () => {
    const emoji = "😀".repeat(NAME_MAX_LENGTH);
    expect(textLength(emoji)).toBe(NAME_MAX_LENGTH);
    expect(validateModel({ ...emptyModel(), meta: { name: emoji } }).ok).toBe(true);
    const m = okModel(addElement(emptyModel(), { kind: "actor", name: emoji }));
    expect(m.elements[0].name).toBe(emoji);
    expectFail(addElement(emptyModel(), { kind: "actor", name: emoji + "😀" }), /名前は 200 文字まで/);
    // 切り詰めても対を割らない
    expect(truncateText(emoji + "😀", NAME_MAX_LENGTH)).toBe(emoji);
  });
});

const long = (n: number) => "あ".repeat(n);

describe("コマンドは上限を超える文字列を失敗にする", () => {
  const base = () => {
    let m = emptyModel();
    m = okModel(addElement(m, { kind: "business", name: "業務" }));
    m = okModel(addElement(m, { kind: "state", name: "状態" }));
    m = okModel(addElement(m, { kind: "variation", name: "区分" }));
    m = okModel(addElement(m, { kind: "issue", name: "課題" }));
    m = okModel(addElement(m, { kind: "activity", name: "作業" }));
    return m;
  };
  const idOf = (m: UntieModel, kind: Element["kind"]) => m.elements.find((e) => e.kind === kind && !(e.kind === "buc" && e.isDefault))!.id;

  it("addElement: 名前・説明・グループ・値", () => {
    expectFail(addElement(emptyModel(), { kind: "actor", name: long(201) }), /^名前は 200 文字までです$/);
    expectFail(addElement(emptyModel(), { kind: "actor", name: "a", init: { description: long(4001) } }), /^説明は 4000 文字までです$/);
    expectFail(addElement(emptyModel(), { kind: "state", name: "a", init: { group: long(201) } }), /状態グループは 200 文字まで/);
    expectFail(addElement(emptyModel(), { kind: "variation", name: "a", init: { values: ["ok", long(201)] } }), /値は 200 文字まで/);
    // 上限ちょうどは通る。名前は trim してから数える
    okModel(addElement(emptyModel(), { kind: "actor", name: ` ${long(200)} `, init: { description: long(4000) } }));
  });

  it("updateElement: 名前・説明・グループ・値・リンク・分析", () => {
    const m = base();
    const [state, variation, issue, activity] = [idOf(m, "state"), idOf(m, "variation"), idOf(m, "issue"), idOf(m, "activity")];
    expectFail(updateElement(m, { id: state, patch: { name: long(201) } }), /^名前は 200 文字までです$/);
    expectFail(updateElement(m, { id: state, patch: { description: long(4001) } }), /^説明は 4000 文字までです$/);
    expectFail(updateElement(m, { id: state, patch: { group: long(201) } }), /状態グループは 200 文字まで/);
    expectFail(updateElement(m, { id: variation, patch: { values: [long(201)] } }), /値は 200 文字まで/);
    expectFail(updateElement(m, { id: activity, patch: { links: [{ title: long(201), url: "https://example.com" }] } }), /リンクの表示名は 200 文字まで/);
    expectFail(updateElement(m, { id: activity, patch: { links: [{ title: "t", url: "https://example.com/" + "a".repeat(2000) }] } }), /リンクの URL は 2000 文字まで/);
    for (const key of ["phenomenon", "location", "cause", "impact"] as const) {
      expectFail(updateElement(m, { id: issue, patch: { analysis: { [key]: long(4001) } } }), /分析の各項目は 4000 文字まで/);
    }
    // 上限ちょうどは通り、できたモデルはスキーマの検証に通る
    let ok = okModel(updateElement(m, { id: issue, patch: { description: long(4000), analysis: { phenomenon: long(4000) } } }));
    ok = okModel(updateElement(ok, { id: activity, patch: { links: [{ title: long(200), url: "https://example.com/" + "a".repeat(1980) }] } }));
    expect(validateModel(JSON.parse(JSON.stringify(ok))).ok).toBe(true);
  });

  it("リンクの表示名が空で URL が長いとき、表示名は URL を上限まで切ったものになる", () => {
    const m = base();
    const url = "https://example.com/" + "a".repeat(1000);
    const next = okModel(updateElement(m, { id: idOf(m, "activity"), patch: { links: [{ title: "", url }] } }));
    const a = next.elements.find((e) => e.kind === "activity")!;
    expect(a.kind === "activity" && a.links![0].title).toHaveLength(LINK_TITLE_MAX_LENGTH);
    expect(validateModel(JSON.parse(JSON.stringify(next))).ok).toBe(true);
  });

  it("失敗したときモデルは変わらない", () => {
    const m = base();
    const r = updateElement(m, { id: idOf(m, "issue"), patch: { name: long(201) } });
    expect(r.ok).toBe(false);
    expect(m.elements.find((e) => e.kind === "issue")!.name).toBe("課題");
  });

  it("ボード名", () => {
    const m = emptyModel();
    expectFail(addBoard(m, { name: long(201) }), /^ボード名は 200 文字までです$/);
    expectFail(renameBoard(m, { id: m.boards[0].id, name: long(201) }), /ボード名は 200 文字まで/);
    expect(okModel(renameBoard(m, { id: m.boards[0].id, name: long(200) })).boards[0].name).toHaveLength(200);
  });
});

describe("repairModel は長すぎる文字列を要素ごと外さず切り詰める", () => {
  const model = (): UntieModel => {
    let m = emptyModel("x", "b1");
    m = okModel(addElement(m, { kind: "actor", name: "担当" }));
    m = okModel(addElement(m, { kind: "business", name: "業務", boardId: "b1" }));
    return m;
  };

  it("説明が 4001 文字の要素が残り、切り詰めたことが changes に出る (中身は出さない)", () => {
    const m = model();
    const actor = m.elements.find((e) => e.kind === "actor")!;
    const broken: UntieModel = {
      ...m,
      meta: { name: long(201), description: long(4001) },
      elements: m.elements.map((e) => (e.id === actor.id ? { ...e, name: "秘密の業務名" + long(200), description: long(4001) } : e)),
      boards: [{ ...m.boards[0], name: long(201) }],
    };
    const { model: fixed, changes } = repairModel(broken);
    expect(fixed.elements.map((e) => e.id)).toEqual(m.elements.map((e) => e.id));
    expect(fixed.elements.find((e) => e.id === actor.id)!.description).toHaveLength(DESCRIPTION_MAX_LENGTH);
    expect(fixed.elements.find((e) => e.id === actor.id)!.name).toHaveLength(NAME_MAX_LENGTH);
    expect(fixed.meta.name).toHaveLength(NAME_MAX_LENGTH);
    expect(fixed.meta.description).toHaveLength(DESCRIPTION_MAX_LENGTH);
    expect(fixed.boards[0].name).toHaveLength(NAME_MAX_LENGTH);
    expect(validateModel(JSON.parse(JSON.stringify(fixed))).ok).toBe(true);
    expect(changes).toEqual(
      expect.arrayContaining([
        `アクター ${actor.id} の名前・説明が長すぎたので切り詰めた`,
        "ファイルの名前・説明が長すぎたので切り詰めた",
        "ボード b1 の名前が長すぎたので切り詰めた",
      ]),
    );
    expect(changes.join("\n")).not.toContain("秘密の業務名");
  });

  it("課題の分析・リンク・値・グループも切り詰める。関係は残る", () => {
    let m = emptyModel("x", "b1");
    m = okModel(addElement(m, { kind: "actor", name: "担当" }));
    m = okModel(addElement(m, { kind: "business", name: "業務" }));
    m = okModel(addElement(m, { kind: "activity", name: "作業" }));
    m = okModel(addElement(m, { kind: "state", name: "状態", init: { group: "g" } }));
    m = okModel(addElement(m, { kind: "variation", name: "区分", init: { values: ["a"] } }));
    m = okModel(addElement(m, { kind: "issue", name: "課題" }));
    const actor = m.elements.find((e) => e.kind === "actor")!;
    const biz = m.elements.find((e) => e.kind === "business")!;
    const rel = okModel(addRelationFor(m, actor.id, biz.id));
    const broken: UntieModel = {
      ...rel,
      elements: rel.elements.map((e) => {
        if (e.kind === "issue") return { ...e, analysis: { phenomenon: long(4001), cause: "ok" } };
        if (e.kind === "activity") return { ...e, links: [{ title: long(201), url: "https://example.com/" + "a".repeat(2000) }] };
        if (e.kind === "state") return { ...e, group: long(201) };
        if (e.kind === "variation") return { ...e, values: [long(201), "b"] };
        return e;
      }),
    };
    expect(validateModel(JSON.parse(JSON.stringify(broken))).ok).toBe(false);
    const { model: fixed } = repairModel(broken);
    expect(validateModel(JSON.parse(JSON.stringify(fixed))).ok).toBe(true);
    expect(fixed.relations).toHaveLength(1);
    expect(fixed.elements).toHaveLength(broken.elements.length);
  });

  it("切り詰めるものが無ければ同じ参照を返す", () => {
    const m = model();
    expect(truncateModelStrings(m).model).toBe(m);
    expect(repairModel(m).model).toBe(m);
  });
});

import { addRelation } from "../commands";
function addRelationFor(m: UntieModel, sourceId: string, targetId: string) {
  return addRelation(m, { sourceId, targetId });
}

describe("truncateElementStrings: 作業の起点 (その他)", () => {
  it("上限を超えたら切り詰め、空文字なら項目ごと消す (minLength: 1 で作業が弾かれないように)", () => {
    const a = { id: "act_x", kind: "activity", name: "作業", bucId: null } as const;
    const long = truncateElementStrings({ ...a, triggerNote: "あ".repeat(TRIGGER_NOTE_MAX_LENGTH + 1) });
    expect((long.element as { triggerNote: string }).triggerNote).toHaveLength(TRIGGER_NOTE_MAX_LENGTH);
    expect(long.fields).toEqual(["起点 (その他)"]);
    const empty = truncateElementStrings({ ...a, triggerNote: "" });
    expect("triggerNote" in empty.element).toBe(false);
    expect(empty.fields).toEqual(["起点 (その他)"]);
    const ok = { ...a, triggerNote: "電話" };
    expect(truncateElementStrings(ok).element).toBe(ok);
  });
});

describe("ペルソナ (0.5.3) の切り詰めと修復", () => {
  const withPersona = (persona: unknown): UntieModel => {
    const m = okModel(addElement(emptyModel(), { kind: "actor", name: "A" }));
    return { ...m, elements: m.elements.map((e) => ({ ...e, persona })) as UntieModel["elements"] };
  };
  const personaOf = (m: UntieModel) => (m.elements[0] as { persona?: Record<string, unknown> }).persona;

  it("長すぎる項目は切り詰める。truncate は IT の習熟に触れず (誤った「長すぎた」の知らせを出さない)、repair が外して知らせる", () => {
    const broken = withPersona({ handle: long(NAME_MAX_LENGTH + 1), attributes: long(NAME_MAX_LENGTH + 1), background: long(DESCRIPTION_MAX_LENGTH + 1), goals: "g", itSkill: "bogus", notes: long(DESCRIPTION_MAX_LENGTH + 1) });
    const truncated = truncateModelStrings(broken);
    expect(truncated.changes).toHaveLength(1);
    expect(truncated.changes[0]).not.toContain("IT の習熟");
    expect(personaOf(truncated.model)!.itSkill).toBe("bogus");
    const { model: fixed, changes } = repairModel(broken);
    expect(personaOf(fixed)).toEqual({ handle: long(NAME_MAX_LENGTH), attributes: long(NAME_MAX_LENGTH), background: long(DESCRIPTION_MAX_LENGTH), goals: "g", notes: long(DESCRIPTION_MAX_LENGTH) });
    expect(changes).toContain("アクター " + broken.elements[0].id + " のペルソナの IT の習熟を外した (値が正しくない)");
    expect(validateModel(JSON.parse(JSON.stringify(fixed))).ok).toBe(true);
  });

  it("全項目が空のペルソナ ({} や、不正な習熟だけ) は repair が persona ごと消す。知らせは習熟の分だけ", () => {
    const empty = repairModel(withPersona({}));
    expect(empty.model.elements[0]).not.toHaveProperty("persona");
    expect(empty.changes).toEqual([]);
    const onlyBad = repairModel(withPersona({ itSkill: "bogus" }));
    expect(onlyBad.model.elements[0]).not.toHaveProperty("persona");
    expect(onlyBad.changes).toHaveLength(1);
    // 切り詰めたあとに空になる場合はないが、空文字だけの項目も消える
    expect(repairModel(withPersona({ handle: "  " })).model.elements[0]).not.toHaveProperty("persona");
  });

  it("正しいペルソナは何も変えない", () => {
    const ok = withPersona({ handle: "田中さん", itSkill: "normal" });
    expect(truncateModelStrings(ok).model).toBe(ok);
    expect(repairModel(ok).changes).toEqual([]);
  });
});
