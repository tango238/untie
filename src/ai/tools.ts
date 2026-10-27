// AI エージェントがモデルを読み書きする道具。3 社のプロバイダーに同じ定義を渡す。
// 道具の中身は既存のコマンド (src/model/commands.ts) を呼ぶだけにし、整合性の検査はコマンドに任せる。
import {
  addElement,
  addRelation,
  moveActivity,
  moveBuc,
  moveToContext,
  removeElement,
  removeRelation,
  setIssueTargets,
  updateElement,
  type CommandResult,
  type ElementPatch,
} from "../model/commands";
import { defaultBucOf } from "../model/selectors";
import { ELEMENT_KINDS, type ElementKind, type UntieModel } from "../model/types";

/** プロバイダーに渡す道具の定義 (JSON Schema) */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 道具がモデルを読み書きする口。エージェントの 1 回の応答の編集は 1 件の履歴にまとめる */
export interface ModelEditor {
  getModel: () => UntieModel;
  apply: <T>(command: (model: UntieModel) => CommandResult<T>) => CommandResult<T>;
}

export interface ToolOutcome {
  ok: boolean;
  /** 道具の結果として AI に返す文字列 (JSON) */
  content: string;
  /** モデルを変えたか */
  changed: boolean;
}

const str = (description: string) => ({ type: "string", description });
const strArray = (description: string) => ({ type: "array", items: { type: "string" }, description });
const linkSchema = {
  type: "array",
  description: "リンク (表示名と URL)。指定すると全部を置き換える",
  items: {
    type: "object",
    properties: { title: str("表示名"), url: str("http:// か https:// で始まる URL") },
    required: ["title", "url"],
    additionalProperties: false,
  },
};

export const MODEL_TOOLS: ToolDef[] = [
  {
    name: "get_model",
    description:
      "今のモデル全体を JSON で返す。要素 (id・種類・名前・種類固有の項目) と関係 (種類・始点 id・終点 id) の一覧。編集の前に必ず呼んで、id を確かめること。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_element",
    description:
      "要素を 1 つ作る。kind ごとの所属: buc は business_id が必須。activity は buc_id か business_id (業務に直接) を指定する。information / state / condition / variation は context_id を指定できる。issue は severity (1〜5) と target_ids を指定できる (登場人物の id だけ = 全体的な課題、業務・作業・操作の id だけ = 具体的な課題。混ぜられない。空なら未整理)。作った要素の id を返す。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...ELEMENT_KINDS], description: "要素の種類" },
        name: str("名前"),
        description: str("説明 (任意)"),
        business_id: str("buc の所属業務。activity を業務に直接置くときの業務"),
        buc_id: str("activity の所属 BUC"),
        context_id: str("information / state / condition / variation の所属コンテキスト"),
        group: str("state の状態グループ名"),
        values: strArray("variation の値の一覧"),
        hours: { type: "number", description: "activity / usecase の時間 (時間単位、小数点第一位まで)" },
        severity: { type: "integer", minimum: 1, maximum: 5, description: "issue の重要度" },
        target_ids: strArray("issue の対象 (登場人物の id だけ、または業務・作業・操作の id だけ)"),
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_element",
    description:
      "要素の名前・説明・種類固有の項目を変える。指定した項目だけ変わる。hours に null を渡すと時間を消す。所属の変更は move_activity / move_buc / set_context を使う。",
    parameters: {
      type: "object",
      properties: {
        id: str("要素の id"),
        name: str("名前"),
        description: str("説明 (空文字で消す)"),
        group: str("state の状態グループ名 (空文字で消す)"),
        values: strArray("variation の値の一覧 (全部を置き換える)"),
        hours: { type: ["number", "null"], description: "activity / usecase の時間。null で消す" },
        links: linkSchema,
        severity: { type: "integer", minimum: 1, maximum: 5, description: "issue の重要度" },
        target_ids: strArray("issue の対象 (全部を置き換える。登場人物だけ、または業務・作業・操作だけ)"),
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_element",
    description:
      "要素を消す。つながる関係・ボード上の配置・課題の対象も消える。業務を消すとその BUC も消え、作業は未所属になる。",
    parameters: { type: "object", properties: { id: str("要素の id") }, required: ["id"], additionalProperties: false },
  },
  {
    name: "add_relation",
    description:
      "2 つの要素を関係で結ぶ。関係の種類は両端の種類から決まる (例: actor → business は主担当、actor / externalActor / system → activity は担当、activity → usecase は使う、usecase → information は扱う、usecase → condition は判断、information ↔ information は関連、information → variation は種別、condition → variation は区分、condition → state は状態参照、state → usecase は実行可、usecase → state は次の状態、system / ledger → information は取得元、information → system / ledger は保存先)。表に無い組み合わせは失敗する。",
    parameters: {
      type: "object",
      properties: { source_id: str("始点の要素 id"), target_id: str("終点の要素 id") },
      required: ["source_id", "target_id"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_relation",
    description: "2 つの要素を結ぶ関係を消す (向きは問わない)。",
    parameters: {
      type: "object",
      properties: { source_id: str("一方の要素 id"), target_id: str("もう一方の要素 id") },
      required: ["source_id", "target_id"],
      additionalProperties: false,
    },
  },
  {
    name: "move_activity",
    description: "作業 (activity) の所属を変える。buc_id か business_id (業務に直接) を指定する。どちらも無ければ未所属にする。",
    parameters: {
      type: "object",
      properties: { activity_id: str("作業の id"), buc_id: str("移す先の BUC"), business_id: str("業務に直接置くときの業務") },
      required: ["activity_id"],
      additionalProperties: false,
    },
  },
  {
    name: "move_buc",
    description: "BUC (活動) の所属業務を変える。所属する作業もついていく。",
    parameters: {
      type: "object",
      properties: { buc_id: str("BUC の id"), business_id: str("移す先の業務") },
      required: ["buc_id", "business_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_context",
    description:
      "情報・状態・条件・バリエーションの所属コンテキストを変える。context_id を省くと未分類にする。状態は状態グループごとにまとめて移る。",
    parameters: {
      type: "object",
      properties: { element_id: str("要素の id"), context_id: str("コンテキストの id (省くと未分類)") },
      required: ["element_id"],
      additionalProperties: false,
    },
  },
];

/** AI に渡すモデルの要約。保存形式から、AI に要らない配置 (ボード) を除く */
export function modelForAi(model: UntieModel): unknown {
  return {
    name: model.meta.name,
    description: model.meta.description,
    elements: model.elements
      .filter((e) => !(e.kind === "buc" && e.isDefault))
      .map((e) => {
        const { id, kind, name, ...rest } = e as unknown as Record<string, unknown>;
        if (kind === "activity" && typeof rest.bucId === "string") {
          // 業務に直接属する作業は、既定 BUC ではなく業務を示す
          const buc = model.elements.find((x) => x.id === rest.bucId);
          if (buc && buc.kind === "buc" && buc.isDefault) {
            delete rest.bucId;
            rest.businessId = buc.businessId;
          }
        }
        return { id, kind, name, ...rest };
      }),
    relations: model.relations.map((r) => [r.kind, r.sourceId, r.targetId]),
  };
}

type Input = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

const okJson = (data: unknown, changed: boolean): ToolOutcome => ({ ok: true, content: JSON.stringify(data), changed });
const fail = (reason: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: reason }), changed: false });

function run<T>(editor: ModelEditor, command: (m: UntieModel) => CommandResult<T>, extra: (r: CommandResult<T> & { ok: true }) => unknown = () => ({ ok: true })): ToolOutcome {
  const before = editor.getModel();
  const r = editor.apply(command);
  if (!r.ok) return fail(r.reason);
  return okJson(extra(r), r.model !== before);
}

/** 道具を 1 回実行する。入力はモデルの出力なので、型を確かめてからコマンドに渡す */
export function executeTool(editor: ModelEditor, name: string, rawInput: unknown): ToolOutcome {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Input;
  switch (name) {
    case "get_model":
      return okJson(modelForAi(editor.getModel()), false);

    case "add_element": {
      const kind = s(input.kind) as ElementKind | undefined;
      const elementName = s(input.name);
      if (!kind || !(ELEMENT_KINDS as readonly string[]).includes(kind)) return fail(`kind は ${ELEMENT_KINDS.join(" / ")} のどれかです`);
      if (!elementName) return fail("name が必要です");
      let bucId = s(input.buc_id);
      const businessId = s(input.business_id);
      if (kind === "activity" && !bucId && businessId) {
        const def = defaultBucOf(editor.getModel(), businessId);
        if (!def) return fail(`業務が存在しません: ${businessId}`);
        bucId = def.id;
      }
      const init = {
        ...(s(input.description) ? { description: s(input.description) } : {}),
        ...(kind === "buc" && businessId ? { businessId } : {}),
        ...(kind === "activity" && bucId ? { bucId } : {}),
        ...(s(input.context_id) ? { contextId: s(input.context_id) } : {}),
        ...(kind === "state" && s(input.group) ? { group: s(input.group) } : {}),
        ...(kind === "variation" && arr(input.values) ? { values: arr(input.values) } : {}),
        ...(kind === "issue" && typeof input.severity === "number" ? { severity: input.severity } : {}),
        ...(kind === "issue" && arr(input.target_ids) ? { targetIds: arr(input.target_ids) } : {}),
      };
      const created = run(editor, (m) => addElement(m, { kind, name: elementName, init }), (r) => ({ id: r.id }));
      if (!created.ok || (kind !== "activity" && kind !== "usecase") || typeof input.hours !== "number") return created;
      // 時間は作ったあとに入れる (検査は updateElement に任せる)
      const id = (JSON.parse(created.content) as { id: string }).id;
      const timed = run(editor, (m) => updateElement(m, { id, patch: { hours: input.hours as number } }));
      return timed.ok ? created : { ...timed, content: JSON.stringify({ id, warning: JSON.parse(timed.content) }) };
    }

    case "update_element": {
      const id = s(input.id);
      if (!id) return fail("id が必要です");
      const patch: ElementPatch = {};
      if (typeof input.name === "string") patch.name = input.name;
      if (typeof input.description === "string") patch.description = input.description;
      if (typeof input.group === "string") patch.group = input.group;
      if (arr(input.values)) patch.values = arr(input.values);
      if (typeof input.hours === "number" || input.hours === null) patch.hours = input.hours as number | null;
      if (Array.isArray(input.links)) {
        patch.links = input.links
          .filter((l): l is { title: unknown; url: unknown } => !!l && typeof l === "object")
          .map((l) => ({ title: String(l.title ?? ""), url: String(l.url ?? "") }));
      }
      if (typeof input.severity === "number") patch.severity = input.severity;
      const targets = arr(input.target_ids);
      if (targets) {
        const r = run(editor, (m) => setIssueTargets(m, { issueId: id, targetIds: targets }));
        if (!r.ok || Object.keys(patch).length === 0) return r;
      }
      if (Object.keys(patch).length === 0) return fail("変える項目がありません");
      return run(editor, (m) => updateElement(m, { id, patch }));
    }

    case "remove_element": {
      const id = s(input.id);
      if (!id) return fail("id が必要です");
      return run(editor, (m) => removeElement(m, { id }));
    }

    case "add_relation": {
      const sourceId = s(input.source_id);
      const targetId = s(input.target_id);
      if (!sourceId || !targetId) return fail("source_id と target_id が必要です");
      return run(editor, (m) => addRelation(m, { sourceId, targetId }), (r) => ({ id: (r as { id?: string }).id }));
    }

    case "remove_relation": {
      const a = s(input.source_id);
      const b = s(input.target_id);
      if (!a || !b) return fail("source_id と target_id が必要です");
      const rel = editor
        .getModel()
        .relations.find((r) => (r.sourceId === a && r.targetId === b) || (r.sourceId === b && r.targetId === a));
      if (!rel) return fail("その 2 つを結ぶ関係はありません");
      return run(editor, (m) => removeRelation(m, { id: rel.id }));
    }

    case "move_activity": {
      const activityId = s(input.activity_id);
      if (!activityId) return fail("activity_id が必要です");
      let bucId = s(input.buc_id) ?? null;
      const businessId = s(input.business_id);
      if (!bucId && businessId) {
        const def = defaultBucOf(editor.getModel(), businessId);
        if (!def) return fail(`業務が存在しません: ${businessId}`);
        bucId = def.id;
      }
      return run(editor, (m) => moveActivity(m, { activityId, bucId }));
    }

    case "move_buc": {
      const bucId = s(input.buc_id);
      const businessId = s(input.business_id);
      if (!bucId || !businessId) return fail("buc_id と business_id が必要です");
      return run(editor, (m) => moveBuc(m, { bucId, businessId }));
    }

    case "set_context": {
      const elementId = s(input.element_id);
      if (!elementId) return fail("element_id が必要です");
      return run(editor, (m) => moveToContext(m, { elementId, contextId: s(input.context_id) ?? null }));
    }

    default:
      return fail(`不明な道具です: ${name}`);
  }
}

