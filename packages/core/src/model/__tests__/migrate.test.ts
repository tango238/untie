import { describe, expect, it } from "vitest";
import { createHotelSample } from "../../sample";
import { compareVersions, loadModelJson, migrateModel, MIGRATIONS, type Migration } from "../migrate";
import { emptyModel, MODEL_VERSION } from "../types";
import { validateModel } from "../validate";

/** 0.1.0 より前の形式 (version が整数の 1) のファイル。中身は 0.2.0 の変換が要らないもの (システムが作業の担当でない) */
const legacy = () => ({ ...createHotelSample(), version: 1 });

/** 0.1.0 のファイル: システムが作業の担当になっている (0.2.0 で操作の対象に変換する) */
function v010(): Record<string, unknown> {
  return {
    version: "0.1.0",
    meta: { name: "0.1.0 のファイル" },
    elements: [
      { id: "actor_a", kind: "actor", name: "担当者" },
      { id: "sys_a", kind: "system", name: "システムA" },
      { id: "act_auto", kind: "activity", name: "システムだけの作業", bucId: null },
      { id: "act_both", kind: "activity", name: "人とシステムの作業", bucId: null },
      { id: "uc_1", kind: "usecase", name: "操作1" },
      { id: "uc_2", kind: "usecase", name: "操作2" },
    ],
    relations: [
      { id: "rel_sys_auto", kind: "actorActivity", sourceId: "sys_a", targetId: "act_auto" },
      { id: "rel_sys_both", kind: "actorActivity", sourceId: "sys_a", targetId: "act_both" },
      { id: "rel_actor_both", kind: "actorActivity", sourceId: "actor_a", targetId: "act_both" },
      { id: "rel_auto_1", kind: "activityUsecase", sourceId: "act_auto", targetId: "uc_1" },
      { id: "rel_both_1", kind: "activityUsecase", sourceId: "act_both", targetId: "uc_1" },
      { id: "rel_both_2", kind: "activityUsecase", sourceId: "act_both", targetId: "uc_2" },
    ],
    boards: [{ id: "board_main", name: "ボード 1", nodes: [], edges: [{ relationId: "rel_sys_both", sourceSide: "bottom" }] }],
  };
}

describe("モデルの形式のバージョン", () => {
  it("現行は 0.5.3。新しいモデル・サンプルはこの版を持ち、スキーマもこの版だけを受ける", () => {
    expect(MODEL_VERSION).toBe("0.5.3");
    expect(emptyModel().version).toBe("0.5.3");
    expect(createHotelSample().version).toBe("0.5.3");
    // スキーマは現行の版だけを受ける (古い版は loadModelJson で変換してから検査する)
    expect(validateModel(legacy()).ok).toBe(false);
    expect(validateModel({ ...createHotelSample(), version: "0.3.0" }).ok).toBe(false);
  });

  it("compareVersions は semver を数として比べる", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
  });

  it("変換は 0.1.0 → 0.2.0 → 0.3.0 → 0.4.0 → 0.4.1 → 0.5.0 → 0.5.1 → 0.5.2 → 0.5.3 の 8 つ", () => {
    expect(MIGRATIONS.map((m) => [m.from, m.to])).toEqual([
      ["0.1.0", "0.2.0"],
      ["0.2.0", "0.3.0"],
      ["0.3.0", "0.4.0"],
      ["0.4.0", "0.4.1"],
      ["0.4.1", "0.5.0"],
      ["0.5.0", "0.5.1"],
      ["0.5.1", "0.5.2"],
      ["0.5.2", "0.5.3"],
    ]);
  });
});

describe("migrateModel", () => {
  it("現行の版はそのまま返す", () => {
    const m = createHotelSample();
    const r = migrateModel(m);
    expect(r).toEqual({ ok: true, json: m, from: "0.5.3", migrated: false, notes: [] });
  });

  it("version が整数の 1 (0.1.0 より前の形式) は 0.1.0 と読み替えて、現行へ変換する。変換の要らない中身は変えず、受け取ったものも書き換えない", () => {
    const old = legacy();
    const r = migrateModel(old);
    expect(r.ok && r.migrated).toBe(true);
    expect(r.ok && r.from).toBe("1");
    expect(r.ok && r.json).toEqual(createHotelSample());
    expect(old.version).toBe(1);
  });

  it("現行より新しい版は、古いアプリで開いて壊さないよう断る", () => {
    const r = migrateModel({ ...createHotelSample(), version: "9.0.0" });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(/新しい版の Untie で作られたファイルです \(モデルの形式 9\.0\.0。この Untie は 0\.5\.3 まで\)/);
  });

  it("古い版は MIGRATIONS を順に当てて現行にする。途中の変換が無ければ断る", () => {
    // 0.1.0 → 0.2.0 → 0.3.0 の変換があるとして確かめる (将来スキーマを変えたときの形)
    const steps: Migration[] = [
      { from: "0.1.0", to: "0.2.0", migrate: (j) => ({ ...j, meta: { ...(j.meta as object), note: "0.2.0 で足した" } }) },
      { from: "0.2.0", to: "0.3.0", migrate: (j) => ({ ...j, elements: [] }) },
    ];
    const r = migrateModel({ ...createHotelSample(), version: "0.1.0" }, steps, "0.3.0");
    expect(r.ok).toBe(true);
    const json = r.ok ? (r.json as Record<string, unknown>) : {};
    expect(json.version).toBe("0.3.0");
    expect(json.meta).toMatchObject({ note: "0.2.0 で足した" });
    expect(json.elements).toEqual([]);
    expect(r.ok && r.migrated).toBe(true);
    // 整数の 1 も、0.1.0 にしてから続けて変換する
    const fromLegacy = migrateModel(legacy(), steps, "0.3.0");
    expect(fromLegacy.ok && (fromLegacy.json as Record<string, unknown>).version).toBe("0.3.0");
    // 0.2.0 からの変換が抜けている
    const broken = migrateModel({ ...createHotelSample(), version: "0.1.0" }, [steps[0]!], "0.3.0");
    expect(broken.ok ? "" : broken.reason).toBe("モデルの形式 0.2.0 から 0.3.0 へ変換できません");
  });

  it("version が無い・形が違う・オブジェクトでないものは変換せずに返す (形の誤りは検証が知らせる)", () => {
    for (const json of [{ meta: {} }, { version: "x" }, { version: 2 }, null, [], "text"]) {
      const r = migrateModel(json);
      expect(r).toEqual({ ok: true, json, from: null, migrated: false, notes: [] });
    }
  });
});

describe("loadModelJson", () => {
  it("古い版のファイルを変換してから検査し、開ける", () => {
    const r = loadModelJson(JSON.parse(JSON.stringify(legacy())));
    expect(r.ok).toBe(true);
    expect(r.ok && r.model.version).toBe("0.5.3");
    expect(r.ok && r.migrated).toBe(true);
    expect(r.ok && r.from).toBe("1");
  });

  it("0.3.0 → 0.4.0: 置き場所 (取得元・保存先) と画面の情報の関係を外し、取得・保存の区別を操作が扱う情報の access に移す。導けない置き場所の件数を知らせる", () => {
    const json = {
      version: "0.3.0",
      meta: { name: "0.3.0 のファイル" },
      elements: [
        { id: "sys_a", kind: "system", name: "システムA" },
        { id: "ldg_a", kind: "ledger", name: "台帳" },
        { id: "scr_a", kind: "screen", name: "画面A", systemId: "sys_a" },
        { id: "uc_read", kind: "usecase", name: "見る" },
        { id: "uc_write", kind: "usecase", name: "書く" },
        { id: "uc_both", kind: "usecase", name: "直す" },
        { id: "uc_paper", kind: "usecase", name: "記入する" },
        { id: "uc_none", kind: "usecase", name: "対象なし" },
        { id: "info_x", kind: "information", name: "X", contextId: null },
        { id: "info_y", kind: "information", name: "Y", contextId: null },
        { id: "info_z", kind: "information", name: "Z (扱う操作なし)", contextId: null },
      ],
      relations: [
        { id: "r_read_scr", kind: "usecaseScreen", sourceId: "uc_read", targetId: "scr_a" },
        { id: "r_write_sys", kind: "usecaseSystem", sourceId: "uc_write", targetId: "sys_a" },
        { id: "r_both_sys", kind: "usecaseSystem", sourceId: "uc_both", targetId: "sys_a" },
        { id: "r_paper", kind: "usecaseSystem", sourceId: "uc_paper", targetId: "ldg_a" },
        { id: "r_read_x", kind: "usecaseInformation", sourceId: "uc_read", targetId: "info_x" },
        { id: "r_write_y", kind: "usecaseInformation", sourceId: "uc_write", targetId: "info_y" },
        { id: "r_both_x", kind: "usecaseInformation", sourceId: "uc_both", targetId: "info_x" },
        { id: "r_paper_y", kind: "usecaseInformation", sourceId: "uc_paper", targetId: "info_y" },
        { id: "r_none_x", kind: "usecaseInformation", sourceId: "uc_none", targetId: "info_x" },
        // 旧: システムA は X の取得元・保存先、Y の保存先。台帳は Y の取得元。Z は置き場所だけ (扱う操作が無い)
        { id: "r_src_x", kind: "systemInformation", sourceId: "sys_a", targetId: "info_x" },
        { id: "r_sto_x", kind: "informationSystem", sourceId: "info_x", targetId: "sys_a" },
        { id: "r_sto_y", kind: "informationSystem", sourceId: "info_y", targetId: "sys_a" },
        { id: "r_src_y_paper", kind: "systemInformation", sourceId: "ldg_a", targetId: "info_y" },
        { id: "r_src_z", kind: "systemInformation", sourceId: "sys_a", targetId: "info_z" },
        { id: "r_scr_x", kind: "screenInformation", sourceId: "scr_a", targetId: "info_x" },
      ],
      boards: [{ id: "board_main", name: "ボード 1", nodes: [], edges: [{ relationId: "r_src_x", sourceSide: "top" }, { relationId: "r_read_x", targetSide: "top" }] }],
    };
    const r = loadModelJson(json);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.model.version).toBe("0.5.3");
    expect(r.notes).toEqual(["情報の取得元・保存先と画面が扱う情報は、操作が扱う情報 (取得・保存) と操作の対象から導くようになったので、6 本の関係を外しました。うち 1 件の置き場所は、その情報を扱う操作の対象になっていないので、導けず消えます"]);
    const kinds = r.model.relations.map((x) => x.kind);
    expect(kinds).not.toContain("systemInformation");
    expect(kinds).not.toContain("informationSystem");
    expect(kinds).not.toContain("screenInformation");
    const access = (id: string) => r.model.relations.find((x) => x.id === id)?.access;
    // X はシステムA で取得も保存もするので、どの操作も区別なし (省略)
    expect(access("r_read_x")).toBeUndefined();
    expect(access("r_both_x")).toBeUndefined();
    // Y はシステムA では保存先だけ → write、台帳では取得元だけ → read
    expect(access("r_write_y")).toBe("write");
    expect(access("r_paper_y")).toBe("read");
    // 対象の無い操作は区別を決められない
    expect(access("r_none_x")).toBeUndefined();
    // 外した関係の線の設定も消える
    expect(r.model.boards[0]!.edges).toEqual([{ relationId: "r_read_x", targetSide: "top" }]);
    // 外す関係が無ければ知らせない
    const plain = loadModelJson({ ...json, relations: json.relations.filter((x) => x.kind === "usecaseInformation"), boards: [{ id: "board_main", name: "ボード 1", nodes: [] }] });
    expect(plain.ok && plain.notes).toEqual([]);
  });

  it("0.4.0 → 0.4.1: 作業の起点 (関係 2 種と triggerNote) は足すだけなので、中身は変わらず、検証に通る", () => {
    const { version: _v, ...rest } = createHotelSample();
    // 起点を持たない 0.4.0 のファイル (作業の triggerNote と、起点の関係を取り除く)
    const old = {
      ...rest,
      version: "0.4.0",
      elements: rest.elements.map((e) => {
        const { triggerNote: _t, ...others } = e as unknown as Record<string, unknown>;
        return others;
      }),
      relations: rest.relations.filter((r) => r.kind !== "activityTrigger" && r.kind !== "eventActivity"),
    };
    const r = loadModelJson(JSON.parse(JSON.stringify(old)));
    expect(r.ok).toBe(true);
    expect(r.ok && r.from).toBe("0.4.0");
    expect(r.ok && r.migrated).toBe(true);
    expect(r.ok && r.model.version).toBe("0.5.3");
    expect(r.ok && r.model.elements).toEqual(old.elements);
    expect(r.ok && r.model.relations).toEqual(old.relations);
    expect(r.ok && r.notes).toEqual([]);
    // 現行の形 (起点つき) は、そのまま開ける (変換しない)
    const withTrigger = loadModelJson(JSON.parse(JSON.stringify(createHotelSample())));
    expect(withTrigger.ok && withTrigger.migrated).toBe(false);
  });

  it("0.4.1 → 0.5.0: 設計モードの入れ物 (designs・databases) を空で足す。中身は変わらず、検証に通る", () => {
    const { designs: _d, databases: _b, ...rest } = createHotelSample();
    const old = { ...rest, version: "0.4.1" };
    const r = loadModelJson(JSON.parse(JSON.stringify(old)));
    expect(r.ok).toBe(true);
    expect(r.ok && r.from).toBe("0.4.1");
    expect(r.ok && r.migrated).toBe(true);
    expect(r.ok && r.model.version).toBe("0.5.3");
    expect(r.ok && r.model.designs).toEqual([]);
    expect(r.ok && r.model.databases).toEqual([]);
    expect(r.ok && r.model.elements).toEqual(old.elements);
    expect(r.ok && r.model.boards).toEqual(old.boards);
    expect(r.ok && r.notes).toEqual([]);
    // 受け取ったものは書き換えない
    expect("designs" in old).toBe(false);
  });

  it("0.3.0 のファイルは 0.5.3 まで続けて変換され、検証に通る (置き場所の導出、起点・設計の入れ物は足すだけ)", () => {
    const { version: _v, designs: _d, databases: _b, ...rest } = createHotelSample();
    const old = {
      ...rest,
      version: "0.3.0",
      elements: rest.elements.map((e) => {
        const { triggerNote: _t, ...others } = e as unknown as Record<string, unknown>;
        return others;
      }),
      relations: rest.relations.filter((r) => r.kind !== "activityTrigger" && r.kind !== "eventActivity"),
    };
    const r = loadModelJson(JSON.parse(JSON.stringify(old)));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.from).toBe("0.3.0");
    expect(r.migrated).toBe(true);
    expect(r.model.version).toBe("0.5.3");
    expect(r.model.designs).toEqual([]);
    expect(r.model.databases).toEqual([]);
    expect(validateModel(r.model).ok).toBe(true);
  });

  it("0.5.0 → 0.5.1: 画面ごとのレイアウトの上書き (DesignScreen.shell) は省略できる項目を足すだけ。中身は変わらず、検証に通る", () => {
    const base = createHotelSample();
    const old = {
      ...base,
      version: "0.5.0",
      designs: [{ systemId: "sys_x4", databaseIds: [], screens: [{ id: "ds_1", source: { kind: "builtin", builtin: "top" } }], transitions: [], layout: { shell: "shell", navigation: [] } }],
    };
    const withSystem = { ...old, elements: [...old.elements, { id: "sys_x4", kind: "system", name: "A" }] };
    const ok = loadModelJson(JSON.parse(JSON.stringify(withSystem)));
    expect(ok.ok && ok.from).toBe("0.5.0");
    expect(ok.ok && ok.migrated).toBe(true);
    expect(ok.ok && ok.model.version).toBe("0.5.3");
    expect(ok.ok && ok.model.designs).toEqual(withSystem.designs);
    expect(ok.ok && ok.notes).toEqual([]);
    // 新しい項目を持つ画面は現行の版で検証に通る
    const now = { ...JSON.parse(JSON.stringify(withSystem)), version: "0.5.3" };
    now.designs[0].screens[0].shell = "plain";
    expect(validateModel(now).ok).toBe(true);
    now.designs[0].screens[0].shell = "bogus";
    expect(validateModel(now).ok).toBe(false);
  });

  it("0.5.1 → 0.5.2: 0.5.1 の JSON (設計あり) は変わらずに変換され、検証に通る。builtin: home の画面は現行の版で通る", () => {
    const base = createHotelSample();
    const old = {
      ...base,
      version: "0.5.1",
      designs: [{ systemId: "sys_x4", databaseIds: [], screens: [{ id: "ds_1", source: { kind: "builtin", builtin: "top" } }, { id: "ds_2", source: { kind: "builtin", builtin: "signIn" }, shell: "plain" }], transitions: [], layout: { shell: "shell", navigation: [] } }],
    };
    const withSystem = { ...old, elements: [...old.elements, { id: "sys_x4", kind: "system", name: "A" }] };
    const r = loadModelJson(JSON.parse(JSON.stringify(withSystem)));
    expect(r.ok && r.from).toBe("0.5.1");
    expect(r.ok && r.migrated).toBe(true);
    expect(r.ok && r.model.version).toBe("0.5.3");
    expect(r.ok && r.model.designs).toEqual(withSystem.designs);
    expect(r.ok && r.notes).toEqual([]);
    const now = { ...JSON.parse(JSON.stringify(withSystem)), version: "0.5.3" };
    now.designs[0].screens.push({ id: "ds_3", source: { kind: "builtin", builtin: "home" } });
    expect(validateModel(now).ok).toBe(true);
    now.designs[0].screens[2].source.builtin = "bogus";
    expect(validateModel(now).ok).toBe(false);
  });

  it("0.5.2 → 0.5.3: 0.5.2 の JSON は変わらずに変換され、検証に通る。ペルソナ (persona) は現行の版で通り、不正な IT の習熟は通らない", () => {
    const base = createHotelSample();
    const old = { ...JSON.parse(JSON.stringify(base)), version: "0.5.2" };
    const r = loadModelJson(JSON.parse(JSON.stringify(old)));
    expect(r.ok && r.from).toBe("0.5.2");
    expect(r.ok && r.migrated).toBe(true);
    expect(r.ok && r.model.version).toBe("0.5.3");
    expect(r.ok && r.model.elements).toEqual(base.elements);
    expect(r.ok && r.notes).toEqual([]);
    const now = JSON.parse(JSON.stringify(base));
    const actor = now.elements.find((e: { kind: string }) => e.kind === "actor");
    actor.persona = { handle: "田中さん", attributes: "45歳", background: "背景", goals: "目標", itSkill: "uncomfortable", notes: "備考" };
    expect(validateModel(now).ok).toBe(true);
    actor.persona.itSkill = "bogus";
    expect(validateModel(now).ok).toBe(false);
    actor.persona = { itSkill: "normal", extra: 1 };
    expect(validateModel(now).ok).toBe(false);
  });

  it("0.2.0 → 0.3.0: 操作の対象 (システム・帳票・画面) を 1 つにする。画面を優先し、同じ種類では先にあるものを残す。外した本数を知らせる", () => {
    const json = {
      version: "0.2.0",
      meta: { name: "0.2.0 のファイル" },
      elements: [
        { id: "sys_a", kind: "system", name: "A" },
        { id: "sys_b", kind: "system", name: "B" },
        { id: "ldg_a", kind: "ledger", name: "台帳" },
        { id: "scr_b", kind: "screen", name: "B の画面", systemId: "sys_b" },
        { id: "scr_a", kind: "screen", name: "A の画面", systemId: "sys_a" },
        { id: "uc_1", kind: "usecase", name: "対象と画面を持つ操作" },
        { id: "uc_2", kind: "usecase", name: "対象を 2 つ持つ操作" },
        { id: "uc_3", kind: "usecase", name: "対象が 1 つの操作" },
      ],
      relations: [
        { id: "r1", kind: "usecaseSystem", sourceId: "uc_1", targetId: "sys_a" },
        { id: "r2", kind: "usecaseScreen", sourceId: "uc_1", targetId: "scr_b" },
        { id: "r3", kind: "usecaseScreen", sourceId: "uc_1", targetId: "scr_a" },
        { id: "r4", kind: "usecaseSystem", sourceId: "uc_2", targetId: "ldg_a" },
        { id: "r5", kind: "usecaseSystem", sourceId: "uc_2", targetId: "sys_b" },
        { id: "r6", kind: "usecaseSystem", sourceId: "uc_3", targetId: "sys_a" },
      ],
      boards: [{ id: "board_main", name: "ボード 1", nodes: [], edges: [{ relationId: "r3", sourceSide: "top" }, { relationId: "r6", sourceSide: "top" }] }],
    };
    // 0.2.0 のままでは検証に通らない (対象が 2 つ以上)
    expect(validateModel({ ...json, version: "0.3.0" }).ok).toBe(false);
    const r = loadModelJson(json);
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.model.relations.map((x) => x.id)).toEqual(["r2", "r4", "r6"]);
    expect(r.model.boards[0]!.edges).toEqual([{ relationId: "r6", sourceSide: "top" }]);
    expect(r.notes).toEqual(["操作の対象は 1 つだけになったので、3 本の対象を外しました (画面を優先して残しています)"]);
  });

  it("0.1.0 → 0.2.0: システムの作業の担当を、その作業が使う操作の対象に移す。システムだけが担当の作業は担当が空になる", () => {
    const r = loadModelJson(v010());
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.model.version).toBe("0.5.3");
    expect(r.from).toBe("0.1.0");
    const rels = r.model.relations.map((x) => [x.kind, x.sourceId, x.targetId]);
    // システム → 作業 (担当) は無くなり、人の担当は残る
    expect(rels.filter((x) => x[0] === "actorActivity")).toEqual([["actorActivity", "actor_a", "act_both"]]);
    // 操作 → システム (対象)。同じ操作に 2 つの作業から来ても 1 本
    expect(rels.filter((x) => x[0] === "usecaseSystem")).toEqual([
      ["usecaseSystem", "uc_1", "sys_a"],
      ["usecaseSystem", "uc_2", "sys_a"],
    ]);
    expect(r.notes).toEqual([]);
    // 消した関係の線の見た目も消える
    expect(r.model.boards[0]!.edges).toBeUndefined();
    // システムだけが担当だった作業は、担当が空になる (検証のエラーで知らせる)
    expect(r.model.relations.some((x) => x.kind === "actorActivity" && x.targetId === "act_auto")).toBe(false);
  });

  it("現行の版はそのまま検査する。新しい版・壊れたものは理由付きで断る", () => {
    const ok = loadModelJson(createHotelSample());
    expect(ok.ok && ok.migrated).toBe(false);
    const newer = loadModelJson({ ...createHotelSample(), version: "0.6.0" });
    expect(newer.ok ? [] : newer.errors).toEqual([expect.stringMatching(/新しい版の Untie/)]);
    const broken = loadModelJson({ version: 1, meta: { name: "x" } });
    expect(broken.ok).toBe(false);
  });
});
