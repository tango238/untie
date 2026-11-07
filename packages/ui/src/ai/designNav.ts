// 設計モードのレイアウトボード「AI で考える」: サイトマップの画面から、利用者にとって自然なナビゲーションのグループ分けを一回きりで作らせる。
// AI は submit_navigation で結果を提出する (文章で JSON を返したときも読む)。存在しない画面の id は捨てる。
import { entryScreenIds, designScreenName } from "@untie/core/model/sitemap";
import { usedDesignIds } from "@untie/core/model/design";
import { newUniqueId } from "@untie/core/model/id";
import { NAME_MAX_LENGTH, truncateText } from "@untie/core/model/limits";
import type { SetDesignNavigationPayload } from "@untie/core/model/commands";
import type { SystemDesign, UntieModel } from "@untie/core/model/types";
import { ChatError, createChatSession } from "./chat";
import { extractJson } from "./designData";
import type { ProviderId } from "./providers";
import type { ToolDef, ToolOutcome } from "./tools";

export interface NavProposal {
  group: string;
  items: { screenId: string; label?: string }[];
}

export const SUBMIT_NAVIGATION_TOOL: ToolDef = {
  name: "submit_navigation",
  description: "ナビゲーションのグループ分けを提出する。グループごとに、画面の id と表示名を並べる。",
  parameters: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description: "グループの並び順がそのままメニューの並び順になる",
        items: {
          type: "object",
          properties: {
            group: { type: "string", description: "グループの名前 (短く)" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  screenId: { type: "string", description: "画面の一覧にある id" },
                  label: { type: "string", description: "メニューに出す短い表示名" },
                },
                required: ["screenId", "label"],
                additionalProperties: false,
              },
            },
          },
          required: ["group", "items"],
          additionalProperties: false,
        },
      },
    },
    required: ["groups"],
    additionalProperties: false,
  },
};

export function navSystemPrompt(): string {
  return `あなたは業務システムの情報設計に詳しい担当者です。システムの画面の一覧から、画面の上部に出すグローバルナビゲーション (メニュー) のグループ分けを作ります。

決まり:
- グループは 3〜7 個、各グループの項目は 1〜6 個にする
- 業務の分類をそのままメニューにせず、利用者がやりたいことの単位でまとめる。よく使う入口の画面を先に置く
- グループ名と項目の表示名は短い日本語にする (画面の名前が長いときは言い換える)
- サインインの画面はメニューに入れない。トップページがあれば、先頭の「ホーム」のグループに入れる
- 画面の id は一覧にあるものだけを使い、同じ画面を 2 回入れない。遷移だけで行く画面 (一覧の行から開く詳細など) は、メニューに入れなくてよい
- 結果は submit_navigation で提出する`;
}

const nameOf = (e: { name: string } | undefined): string => e?.name || "(名前なし)";

/** 画面の材料 (名前・説明・入口か・使う操作と作業・業務・遷移) を渡す依頼の文章 */
export function navRequest(model: UntieModel, systemId: string, design: SystemDesign): string {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const entries = new Set(entryScreenIds(model, systemId, design));
  const names = new Map(design.screens.map((s) => [s.id, designScreenName(model, s)]));
  const screens = design.screens
    .filter((s) => !(s.source.kind === "builtin" && s.source.builtin === "signIn"))
    .map((s) => {
      const analysis = s.source.kind === "screen" ? byId.get(s.source.screenId) : undefined;
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
              return { usecase: nameOf(byId.get(r.sourceId)), activities: activities.map(nameOf), businesses: [...new Set(businesses)] };
            })
        : [];
      return {
        id: s.id,
        name: names.get(s.id)!,
        ...(analysis?.kind === "screen" && analysis.description ? { description: analysis.description } : {}),
        entry: entries.has(s.id),
        ...(s.source.kind === "builtin" ? { builtin: s.source.builtin } : {}),
        ...(usecases.length > 0 ? { usecases } : {}),
        transitionsTo: design.transitions.filter((t) => t.from === s.id).map((t) => ({ to: names.get(t.to) ?? t.to, ...(t.label ? { label: t.label } : {}) })),
      };
    });
  return `システム「${nameOf(byId.get(systemId))}」のナビゲーションのグループ分けを作ってください。

<画面の一覧>
${JSON.stringify(screens, null, 2)}
</画面の一覧>

グループ分けを submit_navigation で提出してください。`;
}

/** 提出された内容 (または文章の中の JSON) を取り出す。形が違えば null */
export function readNavigation(raw: unknown): NavProposal[] | null {
  if (!raw || typeof raw !== "object") return null;
  const groups = (raw as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  return groups.flatMap((g): NavProposal[] => {
    if (!g || typeof g !== "object") return [];
    const x = g as { group?: unknown; items?: unknown };
    if (typeof x.group !== "string" || !Array.isArray(x.items)) return [];
    const items = x.items.flatMap((i) => {
      if (!i || typeof i !== "object") return [];
      const y = i as { screenId?: unknown; label?: unknown };
      if (typeof y.screenId !== "string") return [];
      return [{ screenId: y.screenId, ...(typeof y.label === "string" && y.label.trim() ? { label: y.label.trim() } : {}) }];
    });
    return [{ group: x.group.trim(), items }];
  });
}

/** 存在しない画面・サインイン・重複を捨て、項目の無いグループを捨てる。捨てた画面の数も返す */
export function sanitizeNavigation(design: SystemDesign, proposal: NavProposal[]): { groups: NavProposal[]; dropped: number } {
  const valid = new Set(design.screens.filter((s) => !(s.source.kind === "builtin" && s.source.builtin === "signIn")).map((s) => s.id));
  const seen = new Set<string>();
  let dropped = 0;
  const groups: NavProposal[] = [];
  for (const g of proposal) {
    const items = g.items.filter((i) => {
      if (!valid.has(i.screenId) || seen.has(i.screenId)) {
        dropped++;
        return false;
      }
      seen.add(i.screenId);
      return true;
    });
    // 長すぎる名前は切り詰め、空のグループ名は「(名前なし)」にする
    const group = truncateText(g.group.trim(), NAME_MAX_LENGTH) || "(名前なし)";
    if (items.length > 0) groups.push({ group, items: items.map((i) => (i.label ? { ...i, label: truncateText(i.label, NAME_MAX_LENGTH) } : i)) });
  }
  return { groups, dropped };
}

/** グループに新しい id を付けて、setDesignNavigation に渡せる形にする */
export function withNavIds(model: UntieModel, groups: NavProposal[]): SetDesignNavigationPayload["navigation"] {
  const used = usedDesignIds(model);
  return groups.map((g) => {
    const id = newUniqueId("navGroup", used);
    used.add(id);
    return { id, group: g.group, items: g.items };
  });
}

export interface NavOptions {
  provider: ProviderId;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
}

/** サイトマップの画面から、ナビゲーションのグループ分けを作る。AI が提出しなかった・使える画面が 1 つも無いときは ChatError */
export async function generateNavigation(model: UntieModel, systemId: string, design: SystemDesign, o: NavOptions): Promise<{ groups: NavProposal[]; dropped: number }> {
  const box: { value: { groups: NavProposal[]; dropped: number } | null } = { value: null };

  const runTool = (name: string, input: unknown): ToolOutcome => {
    if (name !== "submit_navigation") return { ok: false, content: JSON.stringify({ error: `不明な道具です: ${name}` }), changed: false };
    const proposal = readNavigation(input);
    if (!proposal) return { ok: false, content: JSON.stringify({ error: "groups (配列) が必要です" }), changed: false };
    const result = sanitizeNavigation(design, proposal);
    if (result.groups.length === 0) return { ok: false, content: JSON.stringify({ error: "使える画面が 1 つもありません。画面の一覧の id を使ってください" }), changed: false };
    box.value = result;
    return { ok: true, content: JSON.stringify({ result: "受け付けました" }), changed: false };
  };

  const session = createChatSession(o.provider, { apiKey: o.apiKey, model: o.model, system: navSystemPrompt(), tools: [SUBMIT_NAVIGATION_TOOL], runTool });
  const text = await session.send(navRequest(model, systemId, design), {}, o.signal);
  if (!box.value) {
    // 道具を呼ばずに文章で JSON を返したときは、それを読む
    const proposal = readNavigation(extractJson(text));
    if (proposal) {
      const result = sanitizeNavigation(design, proposal);
      if (result.groups.length > 0) box.value = result;
    }
  }
  if (!box.value) await session.send("submit_navigation でナビゲーションのグループ分けを提出してください。", {}, o.signal);
  if (!box.value) throw new ChatError("AI がナビゲーションを提出しませんでした。もう一度試してください。");
  return box.value;
}
