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
  /**
   * 変換元の版の JSON を、変換先の版の形へ直す。version はここで書き換えなくてよい (呼ぶ側が to にする)。
   * 中身を消したなど、開く人に知らせることがあれば notes に足す (画面の知らせに出す)
   */
  migrate: (json: Json, notes: string[]) => Json;
}

/**
 * 版ごとの変換。from が古い順に並べ、前のものの to が次の from になるようにつなぐ。
 * 例: { from: "0.1.0", to: "0.2.0", migrate: (json) => ({ ...json, elements: ... }) }
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    // 0.2.0: システムは作業の担当にならない。担当だったシステムは、その作業が使う各操作の「対象」に移す。
    // システムだけが担当だった作業は担当が空になり、検証のエラーで知らせる (人が直す)。
    // イベント・画面・非機能要件と、新しい関係 (対象・発生・きっかけ・次に・画面・扱う・求める) は足すだけなので変換は要らない
    from: "0.1.0",
    to: "0.2.0",
    migrate: migrateSystemPerformerToTarget,
  },
  {
    // 0.3.0: 1 つの操作が持てる対象は、システム・帳票 (usecaseSystem) と画面 (usecaseScreen) を合わせて 1 本まで。
    // 2 本以上あれば、画面を優先し、同じ種類の中では先にあるものを残して、ほかを消す
    from: "0.2.0",
    to: "0.3.0",
    migrate: migrateSingleUsecaseTarget,
  },
  {
    // 0.4.0: 情報の置き場所 (取得元 systemInformation・保存先 informationSystem) と画面が扱う情報 (screenInformation) は保存せず、
    // 操作が扱う情報 (usecaseInformation) と操作の対象から導く。取得・保存の区別は usecaseInformation の access に移す
    from: "0.3.0",
    to: "0.4.0",
    migrate: migrateDerivedPlacement,
  },
  {
    // 0.4.1: 作業の起点。新しい関係 (activityTrigger・eventActivity) と、作業の項目 triggerNote を足すだけなので変換は要らない
    from: "0.4.0",
    to: "0.4.1",
    migrate: (json) => json,
  },
  {
    // 0.5.0: 設計モードの入れ物 (designs・databases)。どちらも必須なので、空配列を足す
    from: "0.4.1",
    to: "0.5.0",
    migrate: (json) => ({ ...json, designs: Array.isArray(json.designs) ? json.designs : [], databases: Array.isArray(json.databases) ? json.databases : [] }),
  },
  {
    // 0.5.1: 設計の画面ごとのレイアウトの上書き (DesignScreen.shell)。省略できる項目を足すだけなので変換は要らない
    from: "0.5.0",
    to: "0.5.1",
    migrate: (json) => json,
  },
  {
    // 0.5.2: 組み込みの画面にホーム (builtin: "home") を足す。列挙に値を足すだけなので変換は要らない
    from: "0.5.1",
    to: "0.5.2",
    migrate: (json) => json,
  },
  {
    // 0.5.3: アクター・外部アクターに任意のペルソナ (persona) を足す。省略できる項目を足すだけなので変換は要らない
    from: "0.5.2",
    to: "0.5.3",
    migrate: (json) => json,
  },
  {
    // 0.5.4: イベントに任意の発生タイミング (timing) を足す。省略できる項目を足すだけなので変換は要らない
    from: "0.5.3",
    to: "0.5.4",
    migrate: (json) => json,
  },
  {
    // 0.6.0: ドメインモデルの入れ物 (domain)。必須なので、空のものを足す
    from: "0.5.4",
    to: "0.6.0",
    migrate: (json) => (typeof json.domain === "object" && json.domain !== null && !Array.isArray(json.domain) ? json : { ...json, domain: { contexts: [], aggregates: [], commands: [], events: [], policies: [], excluded: [], relations: [], terms: [] } }),
  },
];

/**
 * 0.3.0 → 0.4.0: 置き場所と画面の情報の関係を外し、取得・保存の区別を操作が扱う情報の access に移す。
 * 操作 → 情報 ごとに、その操作の対象 (システム・帳票。画面ならその画面のシステム) に、旧データで取得元だけがあれば read、保存先だけがあれば write、両方 (またはどちらも無い) なら省略 (取得も保存も)。
 * どの操作にも扱われていない情報の置き場所と、操作で扱わない画面の情報は導けないので消える (件数を知らせる)
 */
export function migrateDerivedPlacement(json: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  const elements = Array.isArray(json.elements) ? (json.elements as { id?: unknown; kind?: unknown; systemId?: unknown }[]) : [];
  const relations = Array.isArray(json.relations) ? (json.relations as (RelationJson & { access?: unknown })[]) : [];
  const dropped = relations.filter((r) => r && (r.kind === "systemInformation" || r.kind === "informationSystem" || r.kind === "screenInformation"));
  if (dropped.length === 0) return json;

  const systemOfScreen = new Map<string, string>();
  for (const e of elements) if (e && e.kind === "screen" && typeof e.id === "string" && typeof e.systemId === "string") systemOfScreen.set(e.id, e.systemId);
  const placeOf = new Map<string, string>();
  for (const r of relations) {
    if (!r) continue;
    if (r.kind === "usecaseSystem") placeOf.set(r.sourceId, r.targetId);
    if (r.kind === "usecaseScreen") {
      const sys = systemOfScreen.get(r.targetId);
      if (sys) placeOf.set(r.sourceId, sys);
    }
  }
  const sources = new Set(dropped.filter((r) => r.kind === "systemInformation").map((r) => `${r.sourceId}\0${r.targetId}`));
  const stores = new Set(dropped.filter((r) => r.kind === "informationSystem").map((r) => `${r.targetId}\0${r.sourceId}`));

  // 導けるようになった置き場所 (置き場所\0情報)
  const derived = new Set<string>();
  const kept = relations
    .filter((r) => !dropped.includes(r))
    .map((r) => {
      if (!r || r.kind !== "usecaseInformation") return r;
      const place = placeOf.get(r.sourceId);
      if (!place) return r;
      const key = `${place}\0${r.targetId}`;
      derived.add(key);
      const read = sources.has(key);
      const write = stores.has(key);
      const { access: _old, ...rest } = r;
      if (read && !write) return { ...rest, access: "read" };
      if (write && !read) return { ...rest, access: "write" };
      return rest;
    });
  const lostPlaces = new Set([...sources, ...stores].filter((key) => !derived.has(key)));
  const placeNote = lostPlaces.size > 0 ? `。うち ${lostPlaces.size} 件の置き場所は、その情報を扱う操作の対象になっていないので、導けず消えます` : "";
  notes.push(`情報の取得元・保存先と画面が扱う情報は、操作が扱う情報 (取得・保存) と操作の対象から導くようになったので、${dropped.length} 本の関係を外しました${placeNote}`);
  const removedIds = new Set(dropped.map((r) => r.id));
  return { ...json, relations: kept, boards: dropEdges(json.boards, removedIds) };
}

/** 0.2.0 → 0.3.0: 操作の対象 (システム・帳票・画面) を 1 本にする */
function migrateSingleUsecaseTarget(json: Json, notes: string[]): Json {
  const relations = Array.isArray(json.relations) ? (json.relations as RelationJson[]) : [];
  const isTarget = (r: RelationJson) => r && (r.kind === "usecaseSystem" || r.kind === "usecaseScreen");
  const bySource = new Map<string, RelationJson[]>();
  for (const r of relations) if (isTarget(r)) bySource.set(r.sourceId, [...(bySource.get(r.sourceId) ?? []), r]);
  const removedIds = new Set<string>();
  for (const list of bySource.values()) {
    if (list.length < 2) continue;
    const keep = list.find((r) => r.kind === "usecaseScreen") ?? list[0]!;
    for (const r of list) if (r !== keep) removedIds.add(r.id);
  }
  if (removedIds.size === 0) return json;
  notes.push(`操作の対象は 1 つだけになったので、${removedIds.size} 本の対象を外しました (画面を優先して残しています)`);
  return { ...json, relations: relations.filter((r) => !removedIds.has(r?.id)), boards: dropEdges(json.boards, removedIds) };
}

/** ボードごとの線の見た目から、消した関係を外す */
function dropEdges(boards: unknown, removedIds: Set<string>): unknown {
  if (!Array.isArray(boards)) return boards;
  return (boards as Record<string, unknown>[]).map((b) => {
    if (!b || !Array.isArray(b.edges)) return b;
    const edges = (b.edges as { relationId?: unknown }[]).filter((e) => !removedIds.has(String(e?.relationId)));
    const { edges: _old, ...rest } = b;
    return edges.length > 0 ? { ...rest, edges } : rest;
  });
}

interface RelationJson {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
}

/** 0.1.0 → 0.2.0: 「システム → 作業 (担当)」を「操作 → システム (対象)」に移す */
function migrateSystemPerformerToTarget(json: Json): Json {
  const elements = Array.isArray(json.elements) ? (json.elements as { id?: unknown; kind?: unknown }[]) : [];
  const relations = Array.isArray(json.relations) ? (json.relations as RelationJson[]) : [];
  const systems = new Set(elements.filter((e) => e && e.kind === "system").map((e) => e.id));
  const isSystemPerformer = (r: RelationJson) => r && r.kind === "actorActivity" && systems.has(r.sourceId);
  const moved = relations.filter(isSystemPerformer);
  if (moved.length === 0) return json;

  const kept = relations.filter((r) => !isSystemPerformer(r));
  const used = new Set<string>([...elements.map((e) => String(e.id)), ...relations.map((r) => r.id)]);
  const exists = (sourceId: string, targetId: string) => kept.some((r) => r.kind === "usecaseSystem" && r.sourceId === sourceId && r.targetId === targetId);
  const added: RelationJson[] = [];
  for (const m of moved) {
    const usecases = relations.filter((r) => r && r.kind === "activityUsecase" && r.sourceId === m.targetId).map((r) => r.targetId);
    for (const uc of usecases) {
      if (exists(uc, m.sourceId) || added.some((r) => r.sourceId === uc && r.targetId === m.sourceId)) continue;
      let id = `rel_${uc}__${m.sourceId}`;
      for (let n = 2; used.has(id); n++) id = `rel_${uc}__${m.sourceId}_${n}`;
      used.add(id);
      added.push({ id, kind: "usecaseSystem", sourceId: uc, targetId: m.sourceId });
    }
  }
  const removedIds = new Set(moved.map((r) => r.id));
  return { ...json, relations: [...kept, ...added], boards: dropEdges(json.boards, removedIds) };
}

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
      /** 変換で、開く人に知らせること (中身を外したなど) */
      notes: string[];
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
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: true, json, from: null, migrated: false, notes: [] };
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
    return { ok: true, json, from: null, migrated: false, notes: [] };
  }
  const from = raw === 1 ? "1" : version;

  if (compareVersions(version, current) > 0) {
    return { ok: false, reason: `新しい版の Untie で作られたファイルです (モデルの形式 ${version}。この Untie は ${current} まで)。Untie を更新してください` };
  }
  const notes: string[] = [];
  while (compareVersions(version, current) < 0) {
    const step = migrations.find((m) => m.from === version);
    if (!step) return { ok: false, reason: `モデルの形式 ${version} から ${current} へ変換できません` };
    model = { ...step.migrate(model, notes), version: step.to };
    version = step.to;
    migrated = true;
  }
  return { ok: true, json: model, from, migrated, notes };
}

export type LoadModelResult =
  | (ValidationResult & { ok: false })
  | { ok: true; model: UntieModel; from: string | null; migrated: boolean; notes: string[] };

/** 読み込んだ JSON を現行の版へ変換してから、スキーマと参照整合性を検査する (ファイルを開く・取り込むときはこれを通す) */
export function loadModelJson(json: unknown): LoadModelResult {
  const migration = migrateModel(json);
  if (!migration.ok) return { ok: false, errors: [migration.reason] };
  const result = validateModel(migration.json);
  if (!result.ok) return result;
  return { ok: true, model: result.model, from: migration.from, migrated: migration.migrated, notes: migration.notes };
}
