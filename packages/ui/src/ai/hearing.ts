// 困りごとのヒアリング: アクター・外部アクターを 1 人選び、困りごとを聞き出して課題にする。
// 答える側を選べる。
//   persona: AI がそのアクターのペルソナになりきって答え、利用者 (分析する人) が質問する。答えはすべて仮説
//   self:    AI が利用者 (現場の人) に、業務・作業の流れに沿って困りごとを聞く (grill.ts の深掘りと同じ流儀)
// どちらも、まとめて確認が取れてから、道具で課題を登録する (add_issue) か、既存の課題に追記する。
import { addElement, updateElement } from "@untie/core/model/commands";
import {
  ELEMENT_KIND_LABELS,
  ISSUE_ANALYSIS_KEYS,
  ISSUE_ANALYSIS_LABELS,
  ISSUE_ANALYSIS_QUESTIONS,
  PERSONA_FIELD_LABELS,
  PERSONA_IT_SKILL_LABELS,
  isPersonaOwnerKind,
  OVERALL_ISSUE_TARGET_KINDS,
  type Element,
  type IssueAnalysis,
  type Persona,
  type UntieModel,
} from "@untie/core/model/types";
import { runSetIssueTargets, issueWriteTools } from "./grill";
import { executeTool, MODEL_TOOLS, PERSONA_TOOL_PROPERTIES, setPersonaFromInput, type ModelEditor, type ToolDef, type ToolOutcome } from "./tools";

export type HearingAnswerer = "persona" | "self";

export const HEARING_ANSWERER_LABELS: Record<HearingAnswerer, string> = {
  persona: "ペルソナが答える",
  self: "本人に聞く",
};

/** 「まとめる」ボタンが送る固定の発話 */
export const HEARING_SUMMARY_REQUEST = "ここまでの困りごとをまとめてください";

/** 課題にするときの共通の決まり。役を離れる指示は、ペルソナになりきっているときだけ付ける */
function commonRules(answerer: HearingAnswerer): string {
  const leaveRole = answerer === "persona" ? "(役を離れて) " : "";
  const note = answerer === "persona" ? "\n- 答えはすべて仮説なので、新しい課題の説明の最後に「ペルソナ「(呼び名)」へのヒアリングからの仮説」と添える。既存の課題に追記するときは、道具が足す文に「(ペルソナ「(呼び名)」の仮説)」を自動で添える" : "";
  return `まとめと課題の登録:
- 利用者が「まとめて」と言うか、「${HEARING_SUMMARY_REQUEST}」と送ってきたら、${leaveRole}ここまでの困りごとを困りごとごとに 名前・説明・分析 4 項目 (${ISSUE_ANALYSIS_KEYS.map((k) => ISSUE_ANALYSIS_LABELS[k]).join("・")})・重要度 (1〜5)・対象 の案を一覧にして、「この内容で課題を登録しますか?」と確認する
- 材料の「既にある課題」と近い困りごとは、新しく作らず「課題「○○」に追記」として案を出す。追記できるのは、材料の「既にある課題」と、このヒアリングで登録した課題だけ
- 利用者が了承するまで、道具でモデルを変えない。了承されたら、新しい課題は add_issue、既存の課題への追記は update_issue_analysis (と必要なら set_issue_targets) で登録し、何をしたかを短く伝える (要素名で書く。id は書かない)
- update_issue_analysis は、既存の分析を置き換えず、指定した項目の文を既存の文の後ろに改行で足す。足すのは新しく分かったことだけにする (既存の文を書き写さない)
- 課題の名前と説明は、現場の言葉で短く書く。突き止めた中身は分析の 4 項目に分けて書く。既存の課題に追記するときは、担当者が書いた名前と説明 (原文) を変えない
- 対象は、作業・操作・業務まで特定できたらその要素 (具体的な課題)、このアクター全体の話ならこのアクター (全体的な課題)。混ぜない。登場人物を対象にできるのはこのアクターだけ。所在になる作業・操作などがモデルに無ければ、まとめにその旨を書き、要素は作らない (対象は空のまま、所在を分析に書く)
- 対象の id は get_model で確かめた id だけを使う。推測しない${note}`;
}

/** ヒアリングの指示 */
export function hearingSystemPrompt(answerer: HearingAnswerer): string {
  const axes = ISSUE_ANALYSIS_KEYS.map((k, i) => `${i + 1}. ${ISSUE_ANALYSIS_LABELS[k]}: ${ISSUE_ANALYSIS_QUESTIONS[k]}`).join("\n");
  if (answerer === "persona") {
    return `あなたは Untie の AI エージェントで、アクター・外部アクターの 1 人の「ペルソナ」になりきって、業務の困りごとをヒアリングされます。
利用者は業務を分析している人 (設計者・分析者) で、あなたに質問して困りごとを探ります。最初の発話の材料 (<ヒアリング>) に、あなたが演じる人のペルソナ・担当・使う操作・既にある課題が入っています。

演じ方:
- 一人称で、その人の言葉づかいと IT の習熟 (慣れている人は専門用語も使い、苦手な人は「あの画面」「よくわからなくて」のような言い方をする) で話す。業務の言葉で、体験談として答える
- 最初の発話では、まず自己紹介 (呼び名・役割・何を気にしているか) をし、担当する業務・作業の流れを自分の言葉で辿りながら、困っていそうなところを仮説として 2〜3 個挙げ、「気になるところを聞いてください」と促す。長くしすぎない
- ペルソナが無い (材料の persona が空の) ときは、アクターの名前と担当する業務・作業から無理のないペルソナを仮に作って名乗り、最初の発話の最後に「このペルソナで保存しますか?」と提案する。利用者が了承したら set_persona で保存する。了承前に保存しない
- 作業・操作・使うシステムなどの事実は get_model で調べ、事実と食い違う話はしない。モデルに無いことは「たぶん」「そういう場面もあると思う」のように仮説として話す
- 質問されたことに、その人として具体的に (いつ・どのくらい・誰が困る・なぜ) 答える。聞かれていない困りごとを一度に並べない。答えに窮したら、わからないと言ってよい
- 答えはすべて「ペルソナが語った仮説」で、実際の現場の事実ではない。確からしさを断定しない。裏取りが要りそうなところは、現場の人に確かめる点として自分から挙げる

困りごとを探る観点 (利用者の質問に沿って、答えの中に自然に出す):
${axes}

${commonRules("persona")}

利用者が見るのは画面のボードとプロパティ欄なので、作業・操作・活動などの画面での呼び名で話します。`;
  }
  return `あなたは Untie の AI エージェントで、現場の担当者 (アクター・外部アクターの本人) に、業務の困りごとをヒアリングします。
利用者は現場の担当者です。設計者や開発者ではないので、業務の言葉で、答えやすい問いにします。最初の発話の材料 (<ヒアリング>) に、そのアクターのペルソナ・担当・使う操作・既にある課題が入っています。

目的は、担当する業務・作業の流れに沿って、困っていることを見つけ、それぞれを課題にすることです。1 回の会話で、複数の困りごとを扱ってよい。1 つの困りごとは、次の順に掘ります。
困っていること → どの作業・操作で → なぜ → 影響
(分析の 4 項目は、現象・所在・理由・影響に当たります)
${axes}

進め方:
- 作業の流れ (担当する業務 → 作業 → 使う操作) を順に辿り、「この作業で、手間・待ち・間違い・やり直しはありますか?」のように、流れの中の場所から聞く。思い当たらなければ次の作業へ進む
- 質問はラウンドでまとめて出す。前提が揃っていて今すぐ聞ける問いを (3〜4 問まで) 並べ、他の問いの答えに依る問いは次のラウンドに回す
- 問いには Q1、Q2 … と番号を振り、1 行の見出しと短い本文を付ける
- 各問いに、モデルと会話から読み取った見立てを「➡️ 推奨: …」として添える。「はい」と答えれば推奨を採ったことになるように、問いを言い切りの形で書く
- モデルにある事実 (作業の担当、使う操作、扱う情報など) は聞かず、get_model で調べる。聞くのは本人しか知らないこと (いつ・どのくらい・誰が困る・なぜ) だけ
- ペルソナが無い (材料の persona が空の) ときは、最初のラウンドに、ペルソナの要点 (属性・役割・目標・IT の習熟) を 1 問にまとめて入れる。推奨にはアクターの名前と担当から見立てた案を書く。了承されたら set_persona で保存する。了承前に保存しない
- 利用者の答えを待ってから次のラウンドへ進む。答えが曖昧なら、その場で 1 つだけ聞き返す。「もう十分」と言われたらまとめに進む

${commonRules("self")}

利用者が見るのは画面のボードとプロパティ欄なので、作業・操作・活動などの画面での呼び名で話します。`;
}

/** ヒアリングで使う道具。モデルを読む道具は共通、ペルソナを書く道具はこのアクターだけ、課題は新規の登録か既存への追記 */
export const HEARING_TOOLS: ToolDef[] = [
  MODEL_TOOLS.find((t) => t.name === "get_model")!,
  {
    name: "set_persona",
    description:
      "ヒアリング中のアクターのペルソナを書く。指定した項目だけ変わる (空文字で消す)。ペルソナが無いときに仮に作った人物像を、利用者が了承してから呼ぶこと。",
    parameters: { type: "object", properties: { ...PERSONA_TOOL_PROPERTIES }, additionalProperties: false },
  },
  {
    name: "add_issue",
    description:
      "このヒアリングで見つけた困りごとを、新しい課題として登録する (課題の追加と分析・対象の設定を 1 回で行う)。利用者が了承してから呼ぶこと。既にある課題に近いときは使わず、update_issue_analysis で追記する。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "課題の名前 (現場の言葉で短く。200 文字まで)" },
        description: { type: "string", description: "説明 (4000 文字まで)" },
        ...Object.fromEntries(
          ISSUE_ANALYSIS_KEYS.map((k) => [k, { type: "string", description: `${ISSUE_ANALYSIS_LABELS[k]}: ${ISSUE_ANALYSIS_QUESTIONS[k]}` }]),
        ),
        severity: { type: "integer", minimum: 1, maximum: 5, description: "重要度 (1 低 〜 5 高)" },
        target_ids: { type: "array", items: { type: "string" }, description: "対象の要素 id。このアクターの id だけ (全体的な課題)、または業務・作業・操作の id だけ (具体的な課題)。空なら未整理" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  ...issueWriteTools(true),
];

const okJson = (data: unknown, changed: boolean): ToolOutcome => ({ ok: true, content: JSON.stringify(data), changed });
const fail = (reason: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: reason }), changed: false });

/** ヒアリングのセッションが持つ状態。agentStore が会話ごとに作り、新しい会話で空にする */
export interface HearingContext {
  /** このセッションの add_issue で作った課題の id (追記できる課題の範囲に入る) */
  created: Set<string>;
  /** 答え方。persona なら追記する文に仮説の注記を添える */
  answerer: HearingAnswerer;
}

/** 既存の分析に追記する。指定した項目の文は、既存の文を残して改行で足す。note があれば足す文の末尾に添える */
function appendIssueAnalysis(editor: ModelEditor, issueId: string, input: Record<string, unknown>, note: string): ToolOutcome {
  const issue = editor.getModel().elements.find((e) => e.id === issueId);
  if (!issue || issue.kind !== "issue") return fail(`課題が存在しません: ${issueId}`);
  const analysis: Partial<IssueAnalysis> = {};
  for (const k of ISSUE_ANALYSIS_KEYS) {
    const add = typeof input[k] === "string" ? (input[k] as string).trim() : "";
    if (!add) continue;
    const noted = note && !add.includes("仮説") ? `${add} ${note}` : add;
    const current = issue.analysis?.[k]?.trim();
    analysis[k] = current ? `${current}\n${noted}` : noted;
  }
  const patch = {
    ...(Object.keys(analysis).length > 0 ? { analysis } : {}),
    ...(typeof input.severity === "number" ? { severity: input.severity } : {}),
  };
  if (Object.keys(patch).length === 0) return fail("追記する項目がありません");
  const before = editor.getModel();
  const r = editor.apply((m) => updateElement(m, { id: issueId, patch }));
  return r.ok ? okJson({ ok: true }, r.model !== before) : fail(r.reason);
}

/** 対象に登場人物 (アクター・外部アクター・システム・帳票) を含めるなら、このアクターだけを許す */
function checkHearingTargets(model: UntieModel, actorId: string, targetIds: string[]): string | null {
  for (const id of targetIds) {
    const t = model.elements.find((e) => e.id === id);
    if (t && (OVERALL_ISSUE_TARGET_KINDS as readonly string[]).includes(t.kind) && id !== actorId) {
      return `登場人物を対象にできるのは、ヒアリング中のアクターだけです (${t.name || id} は対象にできません)`;
    }
  }
  return null;
}

/**
 * ヒアリングの道具を 1 回実行する。set_persona は actorId のアクターだけに効く。
 * add_issue は課題の追加・分析・対象を 1 回の編集 (1 つのコマンド) で行い、どれかが断られたら何も作らない。
 * update_issue_analysis / set_issue_targets が書ける課題は、材料の「既にある課題」とこのセッションで作った課題 (ctx.created) だけ
 */
export function executeHearingTool(
  editor: ModelEditor,
  actorId: string,
  name: string,
  rawInput: unknown,
  ctx: HearingContext = { created: new Set(), answerer: "self" },
): ToolOutcome {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  switch (name) {
    case "get_model":
      return executeTool(editor, name, input);

    case "set_persona": {
      // このアクター以外は断る (id を受けない定義だが、渡されても別の要素には効かせない)
      if (typeof input.id === "string" && input.id !== actorId) return fail("ヒアリング中のアクター以外のペルソナは変えられません");
      const actor = editor.getModel().elements.find((e) => e.id === actorId);
      if (!actor || !isPersonaOwnerKind(actor.kind)) return fail("ヒアリング中のアクターが見つかりません");
      return setPersonaFromInput(editor, actorId, input);
    }

    case "add_issue": {
      const issueName = typeof input.name === "string" ? input.name.trim() : "";
      if (!issueName) return fail("name が必要です");
      const analysis: Partial<IssueAnalysis> = {};
      for (const k of ISSUE_ANALYSIS_KEYS) if (typeof input[k] === "string" && input[k].trim() !== "") analysis[k] = input[k] as string;
      const targetIds = Array.isArray(input.target_ids) ? input.target_ids.filter((x): x is string => typeof x === "string") : [];
      const targetProblem = checkHearingTargets(editor.getModel(), actorId, targetIds);
      if (targetProblem) return fail(targetProblem);
      const init = {
        ...(typeof input.description === "string" && input.description.trim() !== "" ? { description: input.description } : {}),
        ...(typeof input.severity === "number" ? { severity: input.severity } : {}),
        ...(targetIds.length > 0 ? { targetIds } : {}),
      };
      const before = editor.getModel();
      const r = editor.apply((m) => {
        const added = addElement(m, { kind: "issue", name: issueName, init });
        if (!added.ok || Object.keys(analysis).length === 0) return added;
        const updated = updateElement(added.model, { id: added.id, patch: { analysis } });
        return updated.ok ? { ...updated, id: added.id } : updated;
      });
      if (!r.ok) return fail(r.reason);
      ctx.created.add(r.id);
      return okJson({ id: r.id }, r.model !== before);
    }

    case "update_issue_analysis":
    case "set_issue_targets": {
      const issueId = typeof input.issue_id === "string" ? input.issue_id : "";
      if (!issueId) return fail("issue_id が必要です");
      const model = editor.getModel();
      const target = model.elements.find((e) => e.id === issueId);
      if (!target || target.kind !== "issue") return fail(`課題が存在しません: ${issueId}`);
      const actor = model.elements.find((e) => e.id === actorId);
      const existing = actor ? ((hearingMaterial(model, actor) as { existingIssues: { id: string }[] }).existingIssues.map((i) => i.id)) : [];
      if (!ctx.created.has(issueId) && !existing.includes(issueId)) {
        return fail("この課題は、ヒアリングの材料の「既にある課題」にも、このヒアリングで登録した課題にも入っていないので、書けません");
      }
      if (name === "set_issue_targets") {
        const ids = Array.isArray(input.target_ids) ? input.target_ids.filter((x): x is string => typeof x === "string") : [];
        const problem = checkHearingTargets(model, actorId, ids);
        return problem ? fail(problem) : runSetIssueTargets(editor, issueId, input);
      }
      const persona = actor && (actor.kind === "actor" || actor.kind === "externalActor") ? actor.persona : undefined;
      const note = ctx.answerer === "persona" ? `(ペルソナ「${persona?.handle || actor?.name || ""}」の仮説)` : "";
      return appendIssueAnalysis(editor, issueId, input, note);
    }

    default:
      return fail(`不明な道具です: ${name}`);
  }
}

// ---------------------------------------------------------------- 最初の発言の材料

function personaForAi(persona: Persona | undefined): unknown {
  if (!persona) return null;
  const out: Record<string, string> = {};
  for (const key of ["handle", "attributes", "background", "goals", "notes"] as const) if (persona[key]) out[PERSONA_FIELD_LABELS[key]] = persona[key]!;
  if (persona.itSkill) out[PERSONA_FIELD_LABELS.itSkill] = PERSONA_IT_SKILL_LABELS[persona.itSkill];
  return Object.keys(out).length > 0 ? out : null;
}

/** アクターのまわり (主担当の業務・担当する作業と使う操作・既にある課題) を集める */
export function hearingMaterial(model: UntieModel, actor: Element): unknown {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const ref = (e: Element | undefined) => (e ? { id: e.id, name: e.name } : undefined);
  const out = (kind: string, id: string) => model.relations.filter((r) => r.kind === kind && r.sourceId === id).map((r) => byId.get(r.targetId));

  const businesses = out("actorBusiness", actor.id).filter((e): e is Element => !!e);
  const activities = out("actorActivity", actor.id).filter((e): e is Element => !!e && e.kind === "activity");
  const relatedIds = new Set<string>([actor.id, ...businesses.map((b) => b.id)]);

  const activityRows = activities.map((a) => {
    const buc = a.kind === "activity" && a.bucId ? byId.get(a.bucId) : undefined;
    const business = buc && buc.kind === "buc" ? byId.get(buc.businessId) : undefined;
    relatedIds.add(a.id);
    if (business) relatedIds.add(business.id);
    const usecases = out("activityUsecase", a.id)
      .filter((e): e is Element => !!e && e.kind === "usecase")
      .map((u) => {
        relatedIds.add(u.id);
        const target = model.relations.filter((r) => r.sourceId === u.id && (r.kind === "usecaseSystem" || r.kind === "usecaseScreen")).map((r) => byId.get(r.targetId))[0];
        return {
          ...ref(u),
          ...(u.description ? { description: u.description } : {}),
          ...(target ? { target: { ...ref(target), kindLabel: ELEMENT_KIND_LABELS[target.kind] } } : {}),
        };
      });
    return {
      ...ref(a),
      ...(a.description ? { description: a.description } : {}),
      ...(business ? { business: ref(business) } : {}),
      ...(buc && buc.kind === "buc" && !buc.isDefault ? { buc: ref(buc) } : {}),
      usecases,
    };
  });

  const issues = model.elements.flatMap((e) => {
    if (e.kind !== "issue" || !e.targetIds.some((id) => relatedIds.has(id))) return [];
    return [
      {
        id: e.id,
        name: e.name,
        ...(e.description ? { description: e.description } : {}),
        severity: e.severity,
        ...(e.analysis ? { analysis: e.analysis } : {}),
        targets: e.targetIds.map((id) => ref(byId.get(id))).filter(Boolean),
      },
    ];
  });

  return {
    actor: { id: actor.id, kind: actor.kind, kindLabel: ELEMENT_KIND_LABELS[actor.kind], name: actor.name, ...(actor.description ? { description: actor.description } : {}) },
    persona: personaForAi(actor.kind === "actor" || actor.kind === "externalActor" ? actor.persona : undefined),
    mainBusinesses: businesses.map(ref),
    activities: activityRows,
    existingIssues: issues,
  };
}

/** ヒアリングの最初の発言。アクターのペルソナ・担当・既にある課題を JSON で渡し、最初の発話を求める */
export function hearingOpening(model: UntieModel, actor: Element, answerer: HearingAnswerer): string {
  const data = JSON.stringify(hearingMaterial(model, actor), null, 1);
  const ask =
    answerer === "persona"
      ? `あなたは「${actor.name}」のペルソナになりきって、最初の発話 (自己紹介、担当の流れ、困っていそうな仮説、「気になるところを聞いてください」) をしてください。`
      : `「${actor.name}」の本人に、最初のラウンドの質問を出してください。`;
  return `アクター「${actor.name}」の困りごとをヒアリングします。このアクターのまわりは次のとおりです (persona が null ならペルソナは未設定です)。

<ヒアリング>
${data}
</ヒアリング>

まず get_model でモデルを確かめてから、${ask}`;
}
