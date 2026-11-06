import { describe, expect, it } from "vitest";
import { createHotelSample } from "../../sample";
import { compareVersions, loadModelJson, migrateModel, MIGRATIONS, type Migration } from "../migrate";
import { emptyModel, MODEL_VERSION } from "../types";
import { validateModel } from "../validate";

/** 0.1.0 より前の形式 (version が整数の 1) のファイル */
const legacy = () => ({ ...createHotelSample(), version: 1 });

describe("モデルの形式のバージョン", () => {
  it("現行は 0.1.0。新しいモデル・サンプルはこの版を持ち、スキーマもこの版だけを受ける", () => {
    expect(MODEL_VERSION).toBe("0.1.0");
    expect(emptyModel().version).toBe("0.1.0");
    expect(createHotelSample().version).toBe("0.1.0");
    // スキーマは現行の版だけを受ける (古い版は loadModelJson で変換してから検査する)
    expect(validateModel(legacy()).ok).toBe(false);
    expect(validateModel({ ...createHotelSample(), version: "0.0.9" }).ok).toBe(false);
  });

  it("compareVersions は semver を数として比べる", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
  });

  it("変換はいまは無い (0.1.0 が最初の版)", () => {
    expect(MIGRATIONS).toEqual([]);
  });
});

describe("migrateModel", () => {
  it("現行の版はそのまま返す", () => {
    const m = createHotelSample();
    const r = migrateModel(m);
    expect(r).toEqual({ ok: true, json: m, from: "0.1.0", migrated: false });
  });

  it("version が整数の 1 (0.1.0 より前の形式) は 0.1.0 にする。中身は変えず、受け取ったものも書き換えない", () => {
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
    expect(r.ok ? "" : r.reason).toMatch(/新しい版の Untie で作られたファイルです \(モデルの形式 9\.0\.0。この Untie は 0\.1\.0 まで\)/);
  });

  it("古い版は MIGRATIONS を順に当てて現行にする。途中の変換が無ければ断る", () => {
    // 0.1.0 → 0.2.0 → 0.3.0 の変換があるとして確かめる (将来スキーマを変えたときの形)
    const steps: Migration[] = [
      { from: "0.1.0", to: "0.2.0", migrate: (j) => ({ ...j, meta: { ...(j.meta as object), note: "0.2.0 で足した" } }) },
      { from: "0.2.0", to: "0.3.0", migrate: (j) => ({ ...j, elements: [] }) },
    ];
    const r = migrateModel(createHotelSample(), steps, "0.3.0");
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
    const broken = migrateModel(createHotelSample(), [steps[0]!], "0.3.0");
    expect(broken.ok ? "" : broken.reason).toBe("モデルの形式 0.2.0 から 0.3.0 へ変換できません");
  });

  it("version が無い・形が違う・オブジェクトでないものは変換せずに返す (形の誤りは検証が知らせる)", () => {
    for (const json of [{ meta: {} }, { version: "x" }, { version: 2 }, null, [], "text"]) {
      const r = migrateModel(json);
      expect(r).toEqual({ ok: true, json, from: null, migrated: false });
    }
  });
});

describe("loadModelJson", () => {
  it("古い版のファイルを変換してから検査し、開ける", () => {
    const r = loadModelJson(JSON.parse(JSON.stringify(legacy())));
    expect(r.ok).toBe(true);
    expect(r.ok && r.model.version).toBe("0.1.0");
    expect(r.ok && r.migrated).toBe(true);
    expect(r.ok && r.from).toBe("1");
  });

  it("現行の版はそのまま検査する。新しい版・壊れたものは理由付きで断る", () => {
    const ok = loadModelJson(createHotelSample());
    expect(ok.ok && ok.migrated).toBe(false);
    const newer = loadModelJson({ ...createHotelSample(), version: "0.2.0" });
    expect(newer.ok ? [] : newer.errors).toEqual([expect.stringMatching(/新しい版の Untie/)]);
    const broken = loadModelJson({ version: 1, meta: { name: "x" } });
    expect(broken.ok).toBe(false);
  });
});
