// モデルの形式 (スキーマ) のバージョンと、古い版のファイルを現行へ変換するマイグレーション。純粋関数だけを置く。
// JSON の `version` に semver の文字列で持つ。スキーマを変えるときは、次の 3 つを一緒に行う。
//   1. MODEL_VERSION (types.ts) を上げ、schema/untie.schema.json の version の const を同じ値にする (pnpm gen:types)
//   2. MIGRATIONS に { from: 前の版, to: 新しい版, migrate } を 1 つ足す (前の版の JSON を新しい版の形へ直す)
//   3. __tests__/migrate.test.ts に、前の版のファイルが変換されて検証に通ることを足す
// 読み込み (ファイル・取り込み) は loadModelJson を通すので、古い版のファイルはそのまま開ける。保存すると現行の版で書き出す。
import { MODEL_VERSION, type UntieModel } from "./types";
import { validateModel, type ValidationResult } from "./validate";

type Json = Record<string, unknown>;

export interface Migration {
  /** 変換元の版 */
  from: string;
  /** 変換先の版 */
  to: string;
  /** 変換元の版の JSON を、変換先の版の形へ直す。version はここで書き換えなくてよい (呼ぶ側が to にする) */
  migrate: (json: Json) => Json;
}

/**
 * 版ごとの変換。from が古い順に並べ、前のものの to が次の from になるようにつなぐ。
 * 例: { from: "0.1.0", to: "0.2.0", migrate: (json) => ({ ...json, elements: ... }) }
 */
export const MIGRATIONS: readonly Migration[] = [];

/** semver (x.y.z) を比べる。a が新しければ正、同じなら 0、古ければ負 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

export type MigrateResult =
  | {
      ok: true;
      /** 現行の版になった JSON (変換が要らなければ受け取ったもの) */
      json: unknown;
      /** 読み込んだときの版 (version が無い・読めないときは null) */
      from: string | null;
      /** 変換したか */
      migrated: boolean;
    }
  | { ok: false; reason: string };

/**
 * 古い版の JSON を現行の版 (MODEL_VERSION) へ変換する。受け取ったものは書き換えない。
 * - version が整数の 1 (0.1.0 より前の形式): 中身は同じなので、version を "0.1.0" にする
 * - 現行より古い semver: MIGRATIONS を順に当てる。途中の変換が無ければ失敗
 * - 現行より新しい semver: 新しい版の Untie で作られたファイルなので失敗 (古いアプリで開いて壊さないため)
 * - version が無い・形が違う・オブジェクトでない: 変換せずに返す (形の誤りは validateModel が知らせる)
 */
export function migrateModel(json: unknown, migrations: readonly Migration[] = MIGRATIONS, current = MODEL_VERSION): MigrateResult {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: true, json, from: null, migrated: false };
  let model = json as Json;
  const raw = model.version;
  let version: string;
  let migrated = false;
  if (raw === 1) {
    // 0.1.0 より前の形式。0.1.0 と中身は同じで、version が整数だった
    version = "0.1.0";
    model = { ...model, version };
    migrated = true;
  } else if (typeof raw === "string" && SEMVER.test(raw)) {
    version = raw;
  } else {
    return { ok: true, json, from: null, migrated: false };
  }
  const from = raw === 1 ? "1" : version;

  if (compareVersions(version, current) > 0) {
    return { ok: false, reason: `新しい版の Untie で作られたファイルです (モデルの形式 ${version}。この Untie は ${current} まで)。Untie を更新してください` };
  }
  while (compareVersions(version, current) < 0) {
    const step = migrations.find((m) => m.from === version);
    if (!step) return { ok: false, reason: `モデルの形式 ${version} から ${current} へ変換できません` };
    model = { ...step.migrate(model), version: step.to };
    version = step.to;
    migrated = true;
  }
  return { ok: true, json: model, from, migrated };
}

export type LoadModelResult = (ValidationResult & { ok: false }) | { ok: true; model: UntieModel; from: string | null; migrated: boolean };

/** 読み込んだ JSON を現行の版へ変換してから、スキーマと参照整合性を検査する (ファイルを開く・取り込むときはこれを通す) */
export function loadModelJson(json: unknown): LoadModelResult {
  const migration = migrateModel(json);
  if (!migration.ok) return { ok: false, errors: [migration.reason] };
  const result = validateModel(migration.json);
  if (!result.ok) return result;
  return { ok: true, model: result.model, from: migration.from, migrated: migration.migrated };
}
