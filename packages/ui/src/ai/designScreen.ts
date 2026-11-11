// 設計モードの画面ボード「AI で作る」: 画面の材料 (使う操作・情報・遷移)、使うデータベースのテーブルと列から、
// 画面 UI (mokkun v2 の view) と、項目と列の対応 (bindings) を一回きりで作らせる。AI は submit_screen で結果を提出する。
// view は mokkun の検証 (parseV2Document) に通し、エラーがあれば 1 回だけ出し直させる。存在しないデータベース・テーブル・列の対応は捨てる。
import { screenConditions, screenInformations, usecaseIsReadOnly } from "@untie/core/model/placement";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { viewBindingSlots } from "@untie/core/model/designView";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import { designScreenName, effectiveShell, entryScreenIds } from "@untie/core/model/sitemap";
import type { DesignScreen, SystemDesign, UntieModel } from "@untie/core/model/types";
import { validateView } from "../components/design/viewValidate";
import { ChatError, createChatSession } from "./chat";
import { extractJson } from "./designData";
import type { ProviderId } from "./providers";
import type { ToolDef, ToolOutcome } from "./tools";

export type ScreenBindings = NonNullable<DesignScreen["bindings"]>;

export interface ScreenProposal {
  view: Record<string, unknown>;
  bindings: { item: string; databaseId?: string; table: string; column: string }[];
}

export interface ScreenResult {
  view: Record<string, unknown>;
  bindings: ScreenBindings;
  /** 存在しないデータベース・テーブル・列や、view に無い項目のため捨てた対応の数 */
  dropped: number;
}

export const SUBMIT_SCREEN_TOOL: ToolDef = {
  name: "submit_screen",
  description: "画面 UI (mokkun v2 の view) と、項目と列の対応を提出する。view が mokkun の検証に通らないと、理由が返るので直して出し直す。",
  parameters: {
    type: "object",
    properties: {
      view: { type: "object", description: "mokkun v2 の view (title, goal, sections ...)。遷移は action の navigate / submit の to、一覧の列の to で表す", additionalProperties: true },
      bindings: {
        type: "array",
        description: "項目と列の対応。item は fields[].item、一覧の列は `<セクションの id>.<列の id>`",
        items: {
          type: "object",
          properties: { item: { type: "string" }, databaseId: { type: "string" }, table: { type: "string" }, column: { type: "string" } },
          required: ["item", "databaseId", "table", "column"],
          additionalProperties: false,
        },
      },
    },
    required: ["view", "bindings"],
    additionalProperties: false,
  },
};

export function screenSystemPrompt(): string {
  return `あなたは業務システムの画面設計に詳しい担当者です。業務分析で洗い出した画面の材料から、mokkun v2 の形式で画面 UI (view) を 1 つ作ります。

view の形式 (要点):
- view: { title, goal, layout?: stack|tabs|sectioned, primaryAction?, secondaryActions?, sections: [...] }。title は画面の名前、goal は画面の目的を 1 文で
- section: { id, title, kind: form|list|readonly|summary, columns?: 1|2|3, note?, fields?, list?, actions? }。id は view の中で重ならない英数字
- form は入力、readonly は表示、summary は要約の値を fields に並べる。list は一覧で list に書く
- field: { item, label, component, required?, readonly?, example?, help?, options?, unit? }。item は view の中で重ならない英数字 (camelCase)。例 (example) には架空の値を入れる
- component: text number textarea date time duration file photo_grid select combobox radio checkbox toggle browser badge chip status timeline map。select・combobox・radio には options: [{ value, label }] を付ける
- list: { columns: [{ id, label, type?: text|status|date|number, to? }] (1 つ以上)、search?: boolean、selection?: none|single|multiple、paging?: { pageSize } }
- action: { id, label, kind?: submit|navigate|custom|reset, to?, style?: primary|secondary|tertiary|danger, confirm?: { message } }。id は view の中で重ならない
- 遷移: 別の画面へ行く操作は navigate の action に to (遷移先の画面の id) を書く。送信のあとに行く画面は submit の to。一覧の行から開く画面は list.columns[0].to。to には「この画面からの遷移」の遷移先の画面の id だけを使う

決まり:
- 画面が判断する条件 (conditions) は、条件で変わる表示 (visibleWhen など) の材料にする
- 画面が使う情報を、項目や一覧の列にする。項目名は業務の言葉 (label)、item は英語の識別子にする
- 入力の項目 (form) と一覧の列は、使うデータベースの列に結ぶ (bindings)。検索語は、検索する列に結ぶ。readonly / summary の計算した値 (合計・件数など) は結ばなくてよい。databaseId・table・column は「使うデータベース」にあるものだけを使う
- 一覧の列の対応の item は \`<セクションの id>.<列の id>\`
- 検索や絞り込みの条件は form、結果は list、確認は readonly か summary にする。操作はこの画面からの遷移と、画面の操作 (使う操作) から考える
- 使う操作の種類 (kind) を画面の形の既定にする: query (情報を読むだけの操作) は、検索条件の form と結果の list (か、1 件の readonly) を中心にし、送信の操作を置かない。command (情報を書く操作) は、入力の form と送信 (submit) の操作を中心にする。command に意図の名前 (command。ドメインモデルで決めたコマンドの名前) があれば、送信のボタンの文言にする
- ナビゲーション (メニュー) がある場合、メニューへの遷移は書かない
- 結果は submit_screen で提出する。view が mokkun の検証に通らないと理由が返るので、直して出し直す`;
}

const nameOf = (e: { name: string } | undefined): string => e?.name || "(名前なし)";

/** 画面の材料を渡す依頼の文章 */
export function screenRequest(model: UntieModel, systemId: string, design: SystemDesign, screen: DesignScreen): string {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const names = new Map(design.screens.map((s) => [s.id, designScreenName(model, s)]));
  const analysis = screen.source.kind === "screen" ? byId.get(screen.source.screenId) : undefined;
  const usecases = analysis
    ? model.relations
        .filter((r) => r.kind === "usecaseScreen" && r.targetId === analysis.id)
        .map((r) => {
          const activities = model.relations.filter((a) => a.kind === "activityUsecase" && a.targetId === r.sourceId).map((a) => byId.get(a.sourceId));
          const businesses = activities.flatMap((a) => {
            const buc = a?.kind === "activity" && a.bucId ? byId.get(a.bucId) : undefined;
            const biz = buc?.kind === "buc" && buc.businessId ? byId.get(buc.businessId) : undefined;
            return biz ? [nameOf(biz)] : [];
          });
          const informations = model.relations.filter((i) => i.kind === "usecaseInformation" && i.sourceId === r.sourceId).map((i) => nameOf(byId.get(i.targetId)));
          // 書く情報が 1 つでもあるか、状態を変えるか、出来事を起こすならコマンド。読むだけなら問い合わせ (access の省略は読み書きの両方)
          const kind = usecaseIsReadOnly(model, r.sourceId) ? "query" : "command";
          const command = model.domain.commands.find((c) => c.source?.usecaseId === r.sourceId && c.source.activityId === undefined);
          return { usecase: nameOf(byId.get(r.sourceId)), kind, ...(kind === "command" && command ? { command: command.name } : {}), activities: activities.map(nameOf), businesses: [...new Set(businesses)], informations };
        })
    : [];
  const informations = analysis
    ? (screenInformations(model).get(analysis.id) ?? []).map((d) => {
        const info = byId.get(d.id);
        return { id: d.id, name: nameOf(info), ...(info?.description ? { description: info.description } : {}) };
      })
    : [];
  const conditions = analysis
    ? (screenConditions(model).get(analysis.id) ?? []).map((d) => {
        const c = byId.get(d.id);
        return { name: nameOf(c), ...(c?.description ? { description: c.description } : {}) };
      })
    : [];
  const screenInfo = {
    id: screen.id,
    name: names.get(screen.id)!,
    ...(analysis?.kind === "screen" && analysis.description ? { description: analysis.description } : {}),
    entry: entryScreenIds(model, systemId, design).includes(screen.id),
    ...(screen.source.kind === "builtin" ? { builtin: screen.source.builtin } : {}),
    ...(usecases.length > 0 ? { usecases } : {}),
    ...(informations.length > 0 ? { informations } : {}),
    ...(conditions.length > 0 ? { conditions } : {}),
  };
  const databases = effectiveDatabaseIds(model, design).flatMap((id) => {
    const db = model.databases.find((d) => d.id === id);
    if (!db) return [];
    const schema = parsePrismaDslCached(db.dsl);
    return [
      {
        id: db.id,
        name: db.name,
        tables: schema.models.map((m) => ({
          table: m.name,
          informations: (db.tables.find((t) => t.table === m.name)?.informationIds ?? []).map((i) => nameOf(byId.get(i))),
          columns: m.fields.filter((f) => !f.relation && !schema.models.some((x) => x.name === f.type)).map((f) => ({ name: f.name, type: `${f.type}${f.isList ? "[]" : ""}${f.isOptional ? "?" : ""}` })),
        })),
      },
    ];
  });
  const transitions = design.transitions
    .filter((t) => t.from === screen.id)
    .map((t) => ({ to: t.to, toName: names.get(t.to) ?? t.to, ...(t.via ? { via: t.via } : {}), ...(t.label ? { label: t.label } : {}) }));
  const hasNav = effectiveShell(design, screen) === "shell" && design.layout.navigation.length > 0;
  return `システム「${nameOf(byId.get(systemId))}」の画面「${names.get(screen.id)}」の画面 UI を作ってください。

<画面>
${JSON.stringify(screenInfo, null, 2)}
</画面>

<使うデータベース (テーブルと列。informations はテーブルが表す情報)>
${JSON.stringify(databases, null, 2)}
</使うデータベース>

<この画面からの遷移 (to は遷移先の画面の id。via はきっかけ: button ボタン / row 一覧の行 / afterSubmit 送信のあと)>
${JSON.stringify(transitions, null, 2)}
</この画面からの遷移>

ナビゲーション (メニュー): ${hasNav ? "あり (メニューへの遷移は書かない)" : "なし"}

view と、項目と列の対応 (bindings) を、submit_screen で提出してください。`;
}

/** 提出された内容 (または文章の中の JSON) を取り出す。形が違えば null */
export function readScreenProposal(raw: unknown): ScreenProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { view?: unknown; bindings?: unknown };
  if (!r.view || typeof r.view !== "object" || Array.isArray(r.view)) return null;
  const bindings = (Array.isArray(r.bindings) ? r.bindings : []).flatMap((b) => {
    if (!b || typeof b !== "object") return [];
    const x = b as { item?: unknown; databaseId?: unknown; table?: unknown; column?: unknown };
    if (typeof x.item !== "string" || typeof x.table !== "string" || typeof x.column !== "string") return [];
    return [{ item: x.item, ...(typeof x.databaseId === "string" ? { databaseId: x.databaseId } : {}), table: x.table, column: x.column }];
  });
  return { view: r.view as Record<string, unknown>, bindings };
}

/**
 * 提案の対応から、存在しないデータベース・テーブル・列と、view に無い項目、重複を捨てる (使うデータベースだけが対象)。
 * databaseId が無いときは、使うデータベースが 1 つならそれにする。捨てた数も返す
 */
export function sanitizeBindings(model: UntieModel, design: SystemDesign, view: unknown, proposed: ScreenProposal["bindings"]): { bindings: ScreenBindings; dropped: number } {
  const used = effectiveDatabaseIds(model, design);
  const slots = new Set(viewBindingSlots(view).map((s) => s.key));
  const seen = new Set<string>();
  const bindings: ScreenBindings = [];
  let dropped = 0;
  for (const b of proposed) {
    const databaseId = b.databaseId ?? (used.length === 1 ? used[0] : undefined);
    const db = databaseId !== undefined && used.includes(databaseId) ? model.databases.find((d) => d.id === databaseId) : undefined;
    const table = db ? parsePrismaDslCached(db.dsl).models.find((m) => m.name === b.table) : undefined;
    if (!db || !table || !table.fields.some((f) => f.name === b.column) || !slots.has(b.item) || seen.has(b.item)) {
      dropped++;
      continue;
    }
    seen.add(b.item);
    bindings.push({ item: b.item, databaseId: db.id, table: b.table, column: b.column });
  }
  return { bindings, dropped };
}

export interface ScreenOptions {
  provider: ProviderId;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
}

/**
 * 画面の画面 UI と対応を作る。提出した view が mokkun の検証に通らなければ 1 回だけ出し直させ、まだ通らなければ ChatError。
 * title は画面の名前にそろえる
 */
export async function generateScreen(model: UntieModel, systemId: string, screenId: string, o: ScreenOptions): Promise<ScreenResult> {
  const design = model.designs.find((d) => d.systemId === systemId);
  const screen = design?.screens.find((s) => s.id === screenId);
  if (!design || !screen) throw new ChatError("画面が見つかりません");
  const name = designScreenName(model, screen);
  const otherIds = design.screens.map((s) => s.id).filter((id) => id !== screenId);
  const box: { value: ScreenResult | null; lastError: string } = { value: null, lastError: "" };
  let attempts = 0;

  const evaluate = (proposal: ScreenProposal, final: boolean): { result?: ScreenResult; retry?: string } => {
    const view = { ...proposal.view, title: name };
    const check = validateView(view, screenId, [...otherIds, screenId]);
    if (!check.ok) {
      box.lastError = check.message;
      return final ? {} : { retry: `view が mokkun の検証に通りません。直して submit_screen で出し直してください: ${check.message}` };
    }
    const { bindings, dropped } = sanitizeBindings(model, design, view, proposal.bindings);
    return { result: { view, bindings, dropped } };
  };

  const runTool = (toolName: string, input: unknown): ToolOutcome => {
    if (toolName !== "submit_screen") return { ok: false, content: JSON.stringify({ error: `不明な道具です: ${toolName}` }), changed: false };
    const proposal = readScreenProposal(input);
    if (!proposal) return { ok: false, content: JSON.stringify({ error: "view (オブジェクト) と bindings (配列) が必要です" }), changed: false };
    attempts++;
    const { result, retry } = evaluate(proposal, attempts > 1);
    if (result) {
      box.value = result;
      return { ok: true, content: JSON.stringify({ result: "受け付けました" }), changed: false };
    }
    return { ok: false, content: JSON.stringify({ error: retry ?? box.lastError }), changed: false };
  };

  const session = createChatSession(o.provider, { apiKey: o.apiKey, model: o.model, system: screenSystemPrompt(), tools: [SUBMIT_SCREEN_TOOL], runTool });
  const text = await session.send(screenRequest(model, systemId, design, screen), {}, o.signal);
  if (!box.value && attempts === 0) {
    // 道具を呼ばずに文章で JSON を返したときは、それを読む
    const proposal = readScreenProposal(extractJson(text));
    if (proposal) box.value = evaluate(proposal, true).result ?? null;
    if (!box.value && box.lastError === "") await session.send("submit_screen で画面 UI を提出してください。", {}, o.signal);
  }
  if (!box.value) {
    throw new ChatError(
      box.lastError !== "" ? `AI が作った画面 UI が mokkun の検証に通りませんでした (${box.lastError})。もう一度試してください。` : "AI が画面 UI を提出しませんでした。もう一度試してください。",
    );
  }
  return box.value;
}
