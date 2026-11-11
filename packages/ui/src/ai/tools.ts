// AI エージェントがモデルを読み書きする道具。3 社のプロバイダーに同じ定義を渡す。
// 道具の中身は既存のコマンド (@untie/core の model/commands.ts) を呼ぶだけにし、整合性の検査はコマンドに任せる。
import { screenConditions, screenInformations } from "@untie/core/model/placement";
import {
  addElement,
  addRelation,
  moveActivity,
  moveBuc,
  moveToContext,
  moveToSystem,
  removeElement,
  removeRelation,
  setDatabaseDsl,
  setDesignScreenView,
  setIssueTargets,
  setPersona,
  setEventTiming,
  setRelationAccess,
  setScreenUsecase,
  setTableInformation,
  updateElement,
  type CommandResult,
  type ElementPatch,
} from "@untie/core/model/commands";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { domainReferences } from "@untie/core/model/domain";
import { designsUsingDatabase } from "@untie/core/model/designData";
import { viewBindingSlots, viewShapeProblem } from "@untie/core/model/designView";
import { designScreenName } from "@untie/core/model/sitemap";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import { defaultBucOf, designReferences } from "@untie/core/model/selectors";
import { ELEMENT_KINDS, isPersonaItSkill, isSystemMemberKind, NFR_CATEGORIES, type NfrCategory, isPersonaOwnerKind, PERSONA_IT_SKILLS, PERSONA_FIELD_LABELS, PERSONA_IT_SKILL_LABELS, type ElementKind, type EventTiming, type Persona, type UntieModel } from "@untie/core/model/types";

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

/** ペルソナの入力の項目 (set_persona の引数。ヒアリングの道具と共有する) */
export const PERSONA_TOOL_PROPERTIES = {
  handle: str(`${PERSONA_FIELD_LABELS.handle} (例: 田中さん (店長・45歳)。200 文字まで。空文字で消す)`),
  attributes: str(`${PERSONA_FIELD_LABELS.attributes} (年代・経験年数・勤務形態などを 1 行で。200 文字まで。空文字で消す)`),
  background: str(`${PERSONA_FIELD_LABELS.background} (何を任され、何を気にしているか。4000 文字まで。空文字で消す)`),
  goals: str(`${PERSONA_FIELD_LABELS.goals} (この人が達成したいこと。4000 文字まで。空文字で消す)`),
  it_skill: {
    type: "string",
    enum: [...PERSONA_IT_SKILLS, ""],
    description: `${PERSONA_FIELD_LABELS.itSkill}: ${PERSONA_IT_SKILLS.map((k) => `${k} (${PERSONA_IT_SKILL_LABELS[k]})`).join(" / ")}。空文字で消す`,
  },
  notes: str(`${PERSONA_FIELD_LABELS.notes} (4000 文字まで。空文字で消す)`),
};

/** 指定した項目だけ変えたペルソナを作る (空文字で消す)。入力が不正なら理由を返す */
export function mergePersonaInput(current: Persona | undefined, input: Record<string, unknown>): { persona: Persona } | { error: string } {
  const next: Record<string, unknown> = { ...current };
  let touched = false;
  for (const key of ["handle", "attributes", "background", "goals", "notes"] as const) {
    if (typeof input[key] === "string") {
      next[key] = input[key];
      touched = true;
    }
  }
  if (input.it_skill !== undefined) {
    if (input.it_skill !== "" && !isPersonaItSkill(input.it_skill)) {
      return { error: `it_skill は ${PERSONA_IT_SKILLS.join(" / ")} のどれか (空文字で消す) です` };
    }
    next.itSkill = input.it_skill === "" ? undefined : input.it_skill;
    touched = true;
  }
  if (!touched) return { error: "変える項目がありません" };
  return { persona: next as Persona };
}

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
      "要素を 1 つ作る。kind ごとの所属: buc は business_id が必須。activity は buc_id か business_id (業務に直接) を指定する。information / state / condition / variation は context_id を指定できる。screen (画面) と nfr (非機能要件) は system_id (属するシステム) が必須。nfr は category と verification も指定できる。issue は severity (1〜5) と target_ids を指定できる (登場人物の id だけ = 全体的な課題、業務・作業・操作の id だけ = 具体的な課題。混ぜられない。空なら未整理)。作った要素の id を返す。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...ELEMENT_KINDS], description: "要素の種類" },
        name: str("名前 (200 文字まで)"),
        description: str("説明 (任意。4000 文字まで)"),
        business_id: str("buc の所属業務。activity を業務に直接置くときの業務"),
        buc_id: str("activity の所属 BUC"),
        context_id: str("information / state / condition / variation の所属コンテキスト"),
        system_id: str("screen / nfr の属するシステム (必須)"),
        category: { type: "string", enum: [...NFR_CATEGORIES], description: "nfr の分類" },
        verification: str("nfr の検証方法"),
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
      "要素の名前・説明・種類固有の項目を変える。指定した項目だけ変わる。hours に null を渡すと時間を消す。所属の変更は move_activity / move_buc / set_context / move_to_system を使う。",
    parameters: {
      type: "object",
      properties: {
        id: str("要素の id"),
        name: str("名前 (200 文字まで)"),
        description: str("説明 (空文字で消す。4000 文字まで)"),
        group: str("state の状態グループ名 (空文字で消す)"),
        values: strArray("variation の値の一覧 (全部を置き換える)"),
        hours: { type: ["number", "null"], description: "activity / usecase の時間。null で消す" },
        trigger_note: str("activity の起点のうち作業・イベント以外の 1 行 (例: 電話)。空文字で消す。4000 文字まで"),
        links: linkSchema,
        severity: { type: "integer", minimum: 1, maximum: 5, description: "issue の重要度" },
        target_ids: strArray("issue の対象 (全部を置き換える。登場人物だけ、または業務・作業・操作だけ)"),
        category: { type: ["string", "null"], enum: [...NFR_CATEGORIES, null], description: "nfr の分類。null で未分類にする" },
        verification: str("nfr の検証方法 (空文字で消す)"),
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_persona",
    description:
      "アクターまたは外部アクターのペルソナ (人物像) を書く。指定した項目だけ変わる (空文字で消す)。全項目が空になるとペルソナごと消える。ペルソナはその人の呼び名・属性・背景・目標・IT の習熟・備考。",
    parameters: {
      type: "object",
      properties: { id: str("アクターまたは外部アクターの id"), ...PERSONA_TOOL_PROPERTIES },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_event_timing",
    description:
      "イベントの発生タイミングを置き換える。type が scheduled (定期) なら every の周期 (month 毎月 / day 毎日 / hour 毎時) で繰り返すバッチ処理で、day (毎月の何日。month のとき)・hour (何時。month・day のとき)・minute (何分) で時刻を決める。adhoc (不定期・随時) は Webhook などから API が呼ばれたときのような不定期の処理で、いつ起きるかを note に書く。type を空文字にすると発生タイミングを消す。指定しない項目は持たない (置き換え)。",
    parameters: {
      type: "object",
      properties: {
        id: str("イベントの id"),
        type: { type: "string", enum: ["scheduled", "adhoc", ""], description: "scheduled (定期) / adhoc (不定期・随時)。空文字で消す" },
        every: { type: "string", enum: ["month", "day", "hour"], description: "定期の周期: month (毎月) / day (毎日。既定) / hour (毎時)" },
        day: { type: "integer", minimum: 1, maximum: 31, description: "毎月の何日 (every が month のとき)" },
        hour: { type: "integer", minimum: 0, maximum: 23, description: "何時 (every が month か day のとき)" },
        minute: { type: "integer", minimum: 0, maximum: 59, description: "何分 (定期のとき)" },
        note: str("補足。定期なら「営業日だけ」など、不定期ならいつ起きるか (例: 決済サービスから入金の Webhook を受けたとき)。4000 文字まで"),
      },
      required: ["id", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_element",
    description:
      "要素を消す。つながる関係・ボード上の配置・課題の対象も消える。システム・画面を消すとその設計データ (サイトマップなど)、情報を消すとデータベースのテーブルとの対応も消える (結果に消えた設計データを返す)。業務を消すとその BUC も消え、作業は未所属になる。",
    parameters: { type: "object", properties: { id: str("要素の id") }, required: ["id"], additionalProperties: false },
  },
  {
    name: "add_relation",
    description:
      "2 つの要素を関係で結ぶ。関係の種類は両端の種類から決まる (例: actor → business は主担当、actor / externalActor → activity は担当 (システムは担当にならない)、usecase → system / ledger / screen は対象 (1 つの操作に 1 つだけ)、activity → usecase は使う、usecase → information は扱う、usecase → condition は判断、information ↔ information は関連、information → variation は種別、condition → variation は区分、condition → state は状態参照、state → usecase は実行可、usecase → state は次の状態、activity → activity は作業の起点 (始点が起点になる作業、終点が起点を持つ作業)、event → activity も作業の起点)。表に無い組み合わせは失敗する。情報の置き場所 (システム・帳票の取得元・保存先) と画面が扱う情報は関係にせず、操作が扱う情報 (usecase → information と access) と操作の対象から導く。",
    parameters: {
      type: "object",
      properties: {
        source_id: str("始点の要素 id"),
        target_id: str("終点の要素 id"),
        access: { type: "string", enum: ["read", "write"], description: "usecase → information だけ。操作がその情報を read (取得だけ) するか write (保存だけ) するか。省略は取得も保存もする" },
      },
      required: ["source_id", "target_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_information_access",
    description: "操作が情報をどう扱うか (取得・保存の区別) を変える。usecase → information の関係だけ。access を省くと区別なし (取得も保存も) に戻す。",
    parameters: {
      type: "object",
      properties: {
        usecase_id: str("操作の id"),
        information_id: str("情報の id"),
        access: { type: "string", enum: ["read", "write"], description: "read: 取得だけ、write: 保存だけ。省略で取得も保存も" },
      },
      required: ["usecase_id", "information_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_screen_usecase",
    description:
      "画面を使う操作を入れ替える (操作の対象をその画面にする)。1 つの画面を使う操作は 1 つだけなので、今その画面を使っている操作の対象は外れ、指定した操作の前の対象 (システム・帳票・画面) は画面に置き換わる。usecase_id を省くと、その画面を使う操作をなくす。別の操作が使っている画面へ add_relation で結ぼうとすると失敗するので、こちらを使う。",
    parameters: {
      type: "object",
      properties: { screen_id: str("画面の id"), usecase_id: str("この画面を使う操作の id。省くと使う操作をなくす") },
      required: ["screen_id"],
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
  {
    name: "move_to_system",
    description:
      "画面 (screen) または非機能要件 (nfr) の属するシステムを変える。画面を別のシステムへ移すと、その画面を指していた設計の画面・遷移・ナビゲーションの項目は外れる。",
    parameters: {
      type: "object",
      properties: { element_id: str("画面か非機能要件の id"), system_id: str("移す先のシステムの id") },
      required: ["element_id", "system_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_databases",
    description:
      "設計のデータベースの一覧を返す。各データベースの id・名前・テーブル (DSL の model の名前、表す情報の id と名前、DSL にあるか)・DSL の解析エラーの数・使っている設計 (システム名)。データベースは設計をまたいで共有される。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_database_dsl",
    description: "データベースの DSL (Prisma のスキーマの一部) と、解析エラー (行・列・理由) を返す。DSL を直す前に呼ぶこと。",
    parameters: { type: "object", properties: { database_id: str("データベースの id") }, required: ["database_id"], additionalProperties: false },
  },
  {
    name: "set_database_dsl",
    description:
      "データベースの DSL を置き換える。使えるのは Prisma のスキーマの一部: model / enum、型 (String Int BigInt Float Boolean DateTime Decimal Json Bytes と model・enum の名前、? と [])、@id @unique @default @relation @map、@@id @@unique @@map、// コメント。解析エラーがあっても保存するが、結果に返すので直して出し直すこと。テーブルと情報の対応は set_table_information で付ける。",
    parameters: {
      type: "object",
      properties: { database_id: str("データベースの id"), dsl: str("DSL の全文 (200000 文字まで)") },
      required: ["database_id", "dsl"],
      additionalProperties: false,
    },
  },
  {
    name: "set_table_information",
    description: "テーブル (DSL の model の名前) が表す情報を置き換える。information_ids を空にすると対応を消す。1 つの情報を複数のテーブルが表してもよい。",
    parameters: {
      type: "object",
      properties: { database_id: str("データベースの id"), table: str("テーブル (model) の名前"), information_ids: strArray("表す情報の id (空で対応を消す)") },
      required: ["database_id", "table", "information_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "list_design_screens",
    description:
      "設計モードの画面の一覧を返す。各画面の id (設計の画面の id)・名前・システム・画面 UI (view) の有無・項目と列の対応の数と、対応が無い項目の数。画面 UI は get_design_screen で読み、set_design_screen_view で置き換える。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_design_screen",
    description:
      "設計の画面 1 つの画面 UI (mokkun v2 の view)、項目と列の対応 (bindings)、画面が使う情報、画面が判断する条件 (conditions)、この画面からの遷移、使うデータベースのテーブルと列を返す。画面 UI を直す前に呼ぶこと。",
    parameters: { type: "object", properties: { screen_id: str("設計の画面の id (list_design_screens の id)") }, required: ["screen_id"], additionalProperties: false },
  },
  {
    name: "set_design_screen_view",
    description:
      "設計の画面の画面 UI (view 全体) を置き換える。view は mokkun v2 の view (title, goal, sections ...) で、mokkun の検証に通らなければ失敗にして理由を返す。遷移は action の navigate / submit の to、一覧の列の to に設計の画面の id を書く。bindings は項目と列の対応で、省くと今のまま、渡すと全部を置き換える。",
    parameters: {
      type: "object",
      properties: {
        screen_id: str("設計の画面の id"),
        view: { type: "object", description: "mokkun v2 の view", additionalProperties: true },
        bindings: {
          type: "array",
          description: "項目と列の対応。item は fields[].item、一覧の列は `<セクションの id>.<列の id>`",
          items: {
            type: "object",
            properties: { item: str("項目のキー"), database_id: str("データベースの id"), table: str("テーブルの名前"), column: str("列の名前") },
            required: ["item", "database_id", "table", "column"],
            additionalProperties: false,
          },
        },
      },
      required: ["screen_id", "view"],
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
    relations: model.relations.map((r) => (r.access ? [r.kind, r.sourceId, r.targetId, r.access] : [r.kind, r.sourceId, r.targetId])),
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

/** DSL の解析エラー (先頭 20 件と全体の件数) */
const parseReport = (dsl: string, extra: object = {}) => {
  const errors = parsePrismaDslCached(dsl).errors;
  return { ...extra, parseErrorCount: errors.length, parseErrors: errors.slice(0, 20) };
};

const infoRefs = (ids: string[], name: (id: string) => string) => ids.map((id) => ({ id, name: name(id) }));

/** set_persona の実行。id はアクター・外部アクターでなければ失敗にする (コマンドが検査する) */
export function setPersonaFromInput(editor: ModelEditor, id: string, input: Input): ToolOutcome {
  const target = editor.getModel().elements.find((e) => e.id === id);
  if (!target) return fail(`要素が存在しません: ${id}`);
  if (!isPersonaOwnerKind(target.kind)) return fail("ペルソナを持てるのはアクターと外部アクターだけです");
  const merged = mergePersonaInput((target as { persona?: Persona }).persona, input);
  if ("error" in merged) return fail(merged.error);
  return run(editor, (m) => setPersona(m, { id, persona: merged.persona }));
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
        ...(isSystemMemberKind(kind) && s(input.system_id) ? { systemId: s(input.system_id) } : {}),
        ...(kind === "nfr" && s(input.category) ? { category: s(input.category) as NfrCategory } : {}),
        ...(kind === "nfr" && s(input.verification) ? { verification: s(input.verification) } : {}),
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
      if (typeof input.trigger_note === "string") patch.triggerNote = input.trigger_note;
      if (typeof input.hours === "number" || input.hours === null) patch.hours = input.hours as number | null;
      if (Array.isArray(input.links)) {
        patch.links = input.links
          .filter((l): l is { title: unknown; url: unknown } => !!l && typeof l === "object")
          .map((l) => ({ title: String(l.title ?? ""), url: String(l.url ?? "") }));
      }
      if (typeof input.severity === "number") patch.severity = input.severity;
      if (typeof input.category === "string" || input.category === null) patch.category = input.category as NfrCategory | null;
      if (typeof input.verification === "string") patch.verification = input.verification;
      const targets = arr(input.target_ids);
      if (targets) {
        const r = run(editor, (m) => setIssueTargets(m, { issueId: id, targetIds: targets }));
        if (!r.ok || Object.keys(patch).length === 0) return r;
      }
      if (Object.keys(patch).length === 0) return fail("変える項目がありません");
      return run(editor, (m) => updateElement(m, { id, patch }));
    }

    case "set_persona": {
      const id = s(input.id);
      if (!id) return fail("id が必要です");
      return setPersonaFromInput(editor, id, input);
    }

    case "set_event_timing": {
      const id = s(input.id);
      if (!id) return fail("id が必要です");
      if (input.type === "") return run(editor, (m) => setEventTiming(m, { id, timing: null }));
      const timing: Record<string, unknown> = { type: input.type };
      for (const key of ["every", "day", "hour", "minute", "note"] as const) if (input[key] !== undefined) timing[key] = input[key];
      return run(editor, (m) => setEventTiming(m, { id, timing: timing as unknown as EventTiming }));
    }

    case "remove_element": {
      const id = s(input.id);
      if (!id) return fail("id が必要です");
      // 確認なしで消すが、一緒に消えた設計データは結果に含めて、AI と利用者に伝える
      const removedDesign = [...designReferences(editor.getModel(), id), ...domainReferences(editor.getModel(), id)];
      return run(editor, (m) => removeElement(m, { id }), () => ({ ok: true, ...(removedDesign.length > 0 ? { removedDesign: `設計データ・ドメインモデルも一緒に消えた (か、参照が外れた): ${removedDesign.join("、")}` } : {}) }));
    }

    case "add_relation": {
      const sourceId = s(input.source_id);
      const targetId = s(input.target_id);
      if (!sourceId || !targetId) return fail("source_id と target_id が必要です");
      const access = s(input.access);
      if (access !== undefined && access !== "read" && access !== "write") return fail("access は read か write です");
      return run(editor, (m) => addRelation(m, { sourceId, targetId, ...(access ? { access } : {}) }), (r) => ({ id: (r as { id?: string }).id }));
    }

    case "set_information_access": {
      const usecaseId = s(input.usecase_id);
      const informationId = s(input.information_id);
      if (!usecaseId || !informationId) return fail("usecase_id と information_id が必要です");
      const access = s(input.access);
      if (access !== undefined && access !== "read" && access !== "write") return fail("access は read か write です");
      const rel = editor.getModel().relations.find((r) => r.kind === "usecaseInformation" && r.sourceId === usecaseId && r.targetId === informationId);
      if (!rel) return fail("その操作はその情報を扱っていません (先に add_relation で結んでください)");
      return run(editor, (m) => setRelationAccess(m, { id: rel.id, access: access ?? null }));
    }

    case "set_screen_usecase": {
      const screenId = s(input.screen_id);
      if (!screenId) return fail("screen_id が必要です");
      const usecaseId = s(input.usecase_id) ?? null;
      return run(editor, (m) => setScreenUsecase(m, { screenId, usecaseId }));
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

    case "move_to_system": {
      const elementId = s(input.element_id);
      const systemId = s(input.system_id);
      if (!elementId || !systemId) return fail("element_id と system_id が必要です");
      return run(editor, (m) => moveToSystem(m, { elementId, systemId }));
    }

    case "list_databases": {
      const model = editor.getModel();
      const name = (id: string) => model.elements.find((e) => e.id === id)?.name || "(名前なし)";
      return okJson(
        model.databases.map((db) => {
          const schema = parsePrismaDslCached(db.dsl);
          return {
            id: db.id,
            name: db.name,
            parseErrors: schema.errors.length,
            tables: [
              ...schema.models.map((m) => ({ table: m.name, inDsl: true, informations: infoRefs(db.tables.find((t) => t.table === m.name)?.informationIds ?? [], name) })),
              ...db.tables.filter((t) => !schema.models.some((m) => m.name === t.table)).map((t) => ({ table: t.table, inDsl: false, informations: infoRefs(t.informationIds, name) })),
            ],
            usedBy: designsUsingDatabase(model, db.id).map((u) => name(u.systemId)),
          };
        }),
        false,
      );
    }

    case "get_database_dsl": {
      const id = s(input.database_id);
      if (!id) return fail("database_id が必要です");
      const db = editor.getModel().databases.find((d) => d.id === id);
      if (!db) return fail(`データベースが存在しません: ${id}`);
      return okJson({ id: db.id, name: db.name, dsl: db.dsl, ...parseReport(db.dsl) }, false);
    }

    case "set_database_dsl": {
      const id = s(input.database_id);
      if (!id) return fail("database_id が必要です");
      if (typeof input.dsl !== "string") return fail("dsl が必要です");
      const dsl = input.dsl;
      // 解析エラーがあっても保存する。エラーは結果に返して、AI に直させる
      return run(editor, (m) => setDatabaseDsl(m, { id, dsl }), () => parseReport(dsl, { ok: true }));
    }

    case "set_table_information": {
      const id = s(input.database_id);
      const table = s(input.table);
      const informationIds = arr(input.information_ids);
      if (!id || !table) return fail("database_id と table が必要です");
      if (!informationIds) return fail("information_ids (配列) が必要です");
      return run(editor, (m) => setTableInformation(m, { id, table, informationIds }));
    }

    case "list_design_screens": {
      const model = editor.getModel();
      return okJson(
        model.designs.flatMap((d) =>
          d.screens.map((sc) => {
            const bound = new Set((sc.bindings ?? []).map((b) => b.item));
            return {
              id: sc.id,
              name: designScreenName(model, sc),
              system: model.elements.find((e) => e.id === d.systemId)?.name || "(名前なし)",
              hasView: sc.view !== undefined,
              bindings: sc.bindings?.length ?? 0,
              ...(sc.view !== undefined ? { unmappedItems: viewBindingSlots(sc.view).filter((x) => !bound.has(x.key) && (x.kind === "column" || x.sectionKind === "form")).length } : {}),
            };
          }),
        ),
        false,
      );
    }

    case "get_design_screen": {
      const id = s(input.screen_id);
      if (!id) return fail("screen_id が必要です");
      const model = editor.getModel();
      const design = model.designs.find((d) => d.screens.some((x) => x.id === id));
      const screen = design?.screens.find((x) => x.id === id);
      if (!design || !screen) return fail(`設計に無い画面です: ${id}`);
      const byId = new Map(model.elements.map((e) => [e.id, e]));
      const name = (eid: string) => byId.get(eid)?.name || "(名前なし)";
      const analysisId = screen.source.kind === "screen" ? screen.source.screenId : undefined;
      const databases = effectiveDatabaseIds(model, design).flatMap((dbId) => {
        const db = model.databases.find((d) => d.id === dbId);
        if (!db) return [];
        return [
          {
            id: db.id,
            name: db.name,
            tables: (() => {
              const schema = parsePrismaDslCached(db.dsl);
              const modelNames = new Set(schema.models.map((x) => x.name));
              return schema.models.map((m) => ({
                table: m.name,
                informations: infoRefs(db.tables.find((t) => t.table === m.name)?.informationIds ?? [], name),
                // 他のテーブルを指す関連の列は除く (列の対応に使えるのは値の列)
                columns: m.fields.filter((f) => !modelNames.has(f.type)).map((f) => f.name),
              }));
            })(),
          },
        ];
      });
      return okJson(
        {
          id: screen.id,
          name: designScreenName(model, screen),
          systemId: design.systemId,
          ...(analysisId && byId.get(analysisId)?.description ? { description: byId.get(analysisId)!.description } : {}),
          hasView: screen.view !== undefined,
          ...(screen.view !== undefined ? { view: screen.view } : {}),
          bindings: (screen.bindings ?? []).map((b) => ({ item: b.item, database_id: b.databaseId, table: b.table, column: b.column })),
          informations: analysisId ? (screenInformations(model).get(analysisId) ?? []).map((d) => ({ id: d.id, name: name(d.id) })) : [],
          conditions: analysisId ? (screenConditions(model).get(analysisId) ?? []).map((d) => ({ id: d.id, name: name(d.id), ...(byId.get(d.id)?.description ? { description: byId.get(d.id)!.description } : {}) })) : [],
          transitions: design.transitions
            .filter((t) => t.from === id)
            .map((t) => ({ to: t.to, toName: design.screens.find((x) => x.id === t.to) ? designScreenName(model, design.screens.find((x) => x.id === t.to)!) : t.to, ...(t.via ? { via: t.via } : {}), ...(t.label ? { label: t.label } : {}) })),
          databases,
        },
        false,
      );
    }

    case "set_design_screen_view":
      // mokkun の検証は遅延読み込みの非同期なので、executeToolAsync で扱う
      return fail("set_design_screen_view は executeToolAsync で実行します");

    default:
      return fail(`不明な道具です: ${name}`);
  }
}

/**
 * 道具を 1 回実行する (非同期版)。mokkun の検証が要る道具 (set_design_screen_view) だけここで扱い、ほかは executeTool に任せる。
 * mokkun は大きいので、使うときに読み込む
 */
export async function executeToolAsync(editor: ModelEditor, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (name !== "set_design_screen_view") return executeTool(editor, name, rawInput);
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Input;
  const id = s(input.screen_id);
  if (!id) return fail("screen_id が必要です");
  const model = editor.getModel();
  const design = model.designs.find((d) => d.screens.some((x) => x.id === id));
  if (!design) return fail(`設計に無い画面です: ${id}`);
  let view: unknown = input.view;
  if (typeof view === "string") {
    try {
      view = JSON.parse(view);
    } catch {
      return fail("view は JSON のオブジェクトで渡してください");
    }
  }
  if (!view || typeof view !== "object" || Array.isArray(view)) return fail("view (オブジェクト) が必要です");
  let bindings: { item: string; databaseId: string; table: string; column: string }[] | undefined;
  if (input.bindings !== undefined) {
    if (!Array.isArray(input.bindings)) return fail("bindings は配列で渡してください");
    bindings = [];
    for (const b of input.bindings) {
      const x = (b && typeof b === "object" ? b : {}) as Input;
      const item = s(x.item);
      const databaseId = s(x.database_id);
      const table = s(x.table);
      const column = s(x.column);
      if (!item || !databaseId || !table || !column) return fail("bindings の各要素には item・database_id・table・column が必要です");
      bindings.push({ item, databaseId, table, column });
    }
  }
  const { validateView } = await import("../components/design/viewValidate");
  const screen = design.screens.find((x) => x.id === id)!;
  const analysis = screen.source.kind === "screen" ? model.elements.find((e) => e.id === (screen.source as { screenId: string }).screenId) : undefined;
  const title = designScreenName(model, screen);
  const goal = (analysis?.kind === "screen" && analysis.description?.trim()) || title;
  const shape = viewShapeProblem(view);
  if (shape) return fail(shape);
  // title / goal が無ければ、画面の名前と説明で補って検証する (保存は渡されたまま。プレビューも同じ補いをする)
  const check = validateView({ title, goal, ...(view as Record<string, unknown>) }, id, design.screens.map((x) => x.id));
  if (!check.ok) return fail(`view が mokkun の検証に通りません: ${check.message}`);
  const systemId = design.systemId;
  const slots = viewBindingSlots(view);
  const keys = new Set(slots.map((x) => x.key));
  // view に無い項目の対応は外す (フォーム・YAML の編集と同じ)。bindings を省いたときは、今の対応から外す
  const base = bindings ?? (screen.bindings ?? []).map((b) => ({ ...b }));
  const kept = base.filter((b) => keys.has(b.item));
  const droppedBindings = base.length - kept.length;
  return run(
    editor,
    (m) => setDesignScreenView(m, { systemId, id, view: view as Record<string, unknown>, bindings: kept }),
    () => {
      const bound = new Set(kept.map((b) => b.item));
      return {
        ok: true,
        // 列の対応が無い入力の項目と一覧の列 (要約・表示の値は結ばなくてよい)
        unmappedItems: slots.filter((x) => !bound.has(x.key) && (x.kind === "column" || x.sectionKind === "form")).map((x) => x.key),
        droppedBindings,
      };
    },
  );
}
