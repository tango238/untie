// 課題の深掘り: AI が現場担当者に質問を重ね、課題の現象・所在・理由・影響を突き止めて、その課題だけを更新する。
// 進め方は「設計の木を幅優先で辿り、前提の揃った問いだけをラウンドでまとめて出す」方式 (grill-me) を、
// 現場担当者が答えられる 4 本の軸 (現象・所在・理由・影響) に当てはめたもの。
import { setIssueTargets, updateElement } from "@untie/core/model/commands";
import { relationLabel } from "@untie/core/model/relations";
import {
  ELEMENT_KIND_LABELS,
  ISSUE_ANALYSIS_KEYS,
  ISSUE_ANALYSIS_LABELS,
  ISSUE_ANALYSIS_QUESTIONS,
  type Element,
  type Issue,
  type IssueAnalysis,
  type UntieModel,
} from "@untie/core/model/types";
import { executeTool, MODEL_TOOLS, type ModelEditor, type ToolDef, type ToolOutcome } from "./tools";

/** 深掘りの指示 */
export function grillSystemPrompt(): string {
  const axes = ISSUE_ANALYSIS_KEYS.map((k, i) => `${i + 1}. ${ISSUE_ANALYSIS_LABELS[k]}: ${ISSUE_ANALYSIS_QUESTIONS[k]}`).join("\n");
  return `あなたは Untie の AI エージェントで、現場の担当者が感じている困りごと (課題) を一緒に深掘りします。
利用者は現場の担当者です。設計者や開発者ではないので、業務の言葉で、答えやすい問いにします。

目的は、課題の「所在」と「理由」を具体的にすることです。課題は新しく見つけ出すものではなく、担当者がすでに感じています。足りないのは、それが業務のどの活動・作業・操作 (または登場人物) から生まれているかという具体的な所在と、なぜそこで起きているかという理由です。

深掘りの軸は次の 4 つで、この順に木の根から枝へ辿ります。
${axes}

進め方:
- 質問はラウンドでまとめて出す。前提が揃っていて今すぐ聞ける問いをすべて (3〜4 問まで) 並べ、他の問いの答えに依る問いは次のラウンドに回す
- 問いには Q1、Q2 … と番号を振り、1 行の見出しと短い本文を付ける
- 各問いに、モデルと会話から読み取った見立てを「➡️ 推奨: …」として添える。「はい」と答えれば推奨を採ったことになるように、問いを言い切りの形で書く
- モデルにある事実 (作業の担当、使う操作、扱う情報、所属する業務など) は利用者に聞かず、get_model で調べる。聞くのは利用者しか知らないこと (いつ・どのくらい・誰が困る・なぜ) だけ
- 利用者の答えを待ってから次のラウンドへ進む。答えが曖昧なら、その場で 1 つだけ聞き返す
- 開いた問いが無くなったら (または利用者が「もう十分」と言ったら)、4 つの軸ごとに短くまとめ、重要度と対象 (所在の要素) の案を示して「この内容で課題を更新しますか?」と確認する
- 利用者が了承するまで道具で課題を変えない。了承されたら update_issue_analysis と set_issue_targets で更新し、何を変えたかを短く伝える (要素名で書く。id は書かない)
- 所在になる作業・操作などがモデルに無ければ、まとめにその旨を書き、先にその要素を足してから対象を付けるよう案内する (この深掘りでは要素を作らない)
- 担当者が書いた課題の名前と説明 (原文) は変えない。突き止めた内容は分析の 4 項目に分けて書く
- 対象は、登場人物だけ (全体的な課題) か、業務・作業・操作だけ (具体的な課題) のどちらかにする。混ぜない

利用者が見るのは画面のボードとプロパティ欄なので、作業・操作・活動などの画面での呼び名で話します。`;
}

/** 深掘りで使う道具。モデルを読む道具は共通、書く道具はこの課題に限る */
export const GRILL_TOOLS: ToolDef[] = [
  MODEL_TOOLS.find((t) => t.name === "get_model")!,
  {
    name: "update_issue_analysis",
    description:
      "深掘り中の課題の分析 (現象・所在・理由・影響) と重要度を書く。指定した項目だけ変わる (空文字で消す)。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: {
        ...Object.fromEntries(
          ISSUE_ANALYSIS_KEYS.map((k) => [k, { type: "string", description: `${ISSUE_ANALYSIS_LABELS[k]}: ${ISSUE_ANALYSIS_QUESTIONS[k]}` }]),
        ),
        severity: { type: "integer", minimum: 1, maximum: 5, description: "重要度 (1 低 〜 5 高)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_issue_targets",
    description:
      "深掘り中の課題の対象 (所在の要素) を置き換える。登場人物の id だけ (全体的な課題)、または業務・作業・操作の id だけ (具体的な課題)。空にすると未整理に戻る。利用者が了承してから呼ぶこと。",
    parameters: {
      type: "object",
      properties: { target_ids: { type: "array", items: { type: "string" }, description: "対象の要素 id" } },
      required: ["target_ids"],
      additionalProperties: false,
    },
  },
];

const okJson = (data: unknown, changed: boolean): ToolOutcome => ({ ok: true, content: JSON.stringify(data), changed });
const fail = (reason: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: reason }), changed: false });

/** 深掘りの道具を 1 回実行する。書く道具は issueId の課題にだけ効く */
export function executeGrillTool(editor: ModelEditor, issueId: string, name: string, rawInput: unknown): ToolOutcome {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  switch (name) {
    case "get_model":
      return executeTool(editor, name, input);

    case "update_issue_analysis": {
      const analysis: Partial<IssueAnalysis> = {};
      for (const k of ISSUE_ANALYSIS_KEYS) if (typeof input[k] === "string") analysis[k] = input[k] as string;
      const patch = {
        ...(Object.keys(analysis).length > 0 ? { analysis } : {}),
        ...(typeof input.severity === "number" ? { severity: input.severity } : {}),
      };
      if (Object.keys(patch).length === 0) return fail("変える項目がありません");
      const before = editor.getModel();
      const r = editor.apply((m) => updateElement(m, { id: issueId, patch }));
      return r.ok ? okJson({ ok: true }, r.model !== before) : fail(r.reason);
    }

    case "set_issue_targets": {
      const targetIds = Array.isArray(input.target_ids) ? input.target_ids.filter((x): x is string => typeof x === "string") : null;
      if (!targetIds) return fail("target_ids が必要です");
      const before = editor.getModel();
      const r = editor.apply((m) => setIssueTargets(m, { issueId, targetIds }));
      return r.ok ? okJson({ ok: true }, r.model !== before) : fail(r.reason);
    }

    default:
      return fail(`不明な道具です: ${name}`);
  }
}

/** 対象の要素と、そのまわり (所属とつながる要素)。AI が所在の見立てを立てるのに使う */
function targetForAi(model: UntieModel, target: Element): unknown {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const ref = (e: Element | undefined) => (e ? { id: e.id, kind: e.kind, kindLabel: ELEMENT_KIND_LABELS[e.kind], name: e.name } : undefined);
  const belongsTo: unknown[] = [];
  if (target.kind === "activity" && target.bucId) {
    const buc = byId.get(target.bucId);
    if (buc && buc.kind === "buc") {
      if (!buc.isDefault) belongsTo.push(ref(buc));
      belongsTo.push(ref(byId.get(buc.businessId)));
    }
  }
  if (target.kind === "buc") belongsTo.push(ref(byId.get(target.businessId)));
  const relations = model.relations
    .filter((r) => r.sourceId === target.id || r.targetId === target.id)
    .map((r) => {
      const other = byId.get(r.sourceId === target.id ? r.targetId : r.sourceId);
      return { label: relationLabel(r.kind), direction: r.sourceId === target.id ? "to" : "from", ...ref(other) };
    });
  return {
    ...ref(target),
    ...(target.description ? { description: target.description } : {}),
    ...(belongsTo.length > 0 ? { belongsTo } : {}),
    relations,
  };
}

/** 深掘りの最初の発言。課題と対象のまわりを JSON で渡し、最初のラウンドを求める */
export function grillOpening(model: UntieModel, issue: Issue): string {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const targets = issue.targetIds.flatMap((id) => {
    const t = byId.get(id);
    return t ? [targetForAi(model, t)] : [];
  });
  const data = {
    issue: {
      id: issue.id,
      name: issue.name,
      ...(issue.description ? { description: issue.description } : {}),
      severity: issue.severity,
      ...(issue.analysis ? { analysis: issue.analysis } : {}),
    },
    targets,
  };
  return `次の課題を深掘りします。課題と、いまの対象のまわりは次のとおりです (対象が空なら未整理で、所在はこれから突き止めます)。

<課題>
${JSON.stringify(data, null, 1)}
</課題>

まず get_model でモデルを確かめてから、最初のラウンドの質問を出してください。`;
}
