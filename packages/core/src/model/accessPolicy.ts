// 権限表 (6.1)。分析の「誰が (アクター) → どの作業で → どの操作を → どの情報に」から、対象のシステムの
// 「役割 × 操作」の表を機械的に導く。生成したアプリケーションは、権限を自分のコードに書かず、この表を共通の仕組み
// (packages/appkit) に渡して判定する。監査の記録に載せるもの (操作が扱う情報と、取得・保存の区別) も、あわせて持たせる。純粋関数だけを置く。
import { usecasePlaces } from "./placement";
import type { Relation, UntieModel } from "./types";

/** 役割。分析のアクター 1 つが、1 つの役割になる (id はアクターの id) */
export interface AccessRole {
  id: string;
  name: string;
}

/** 操作を行える役割。own が true なら、本人のもの (対象の持ち主が、ログインしている本人) に限る */
export interface AccessAllow {
  role: string;
  own?: true;
}

export interface AccessOperation {
  /** 操作の id (分析の操作の id) */
  id: string;
  name: string;
  /** 行える役割。空なら、人は行えない (出来事をきっかけに、システムが行う) */
  allow: AccessAllow[];
  /** 出来事をきっかけに、システムが行うことがある */
  byEvent: boolean;
  /** 扱う情報 (監査の記録に載せる)。access は read (取得)・write (保存)・both (両方) */
  informations: { id: string; name: string; access: "read" | "write" | "both" }[];
}

/** 設計で決まっていないので、表にできなかったもの */
export interface AccessPending {
  usecaseId: string;
  operation: string;
  reason: string;
}

export interface AccessPolicy {
  format: 1;
  systemId: string;
  system: string;
  /** このシステムの操作を 1 つでも行える役割 (モデルの順) */
  roles: AccessRole[];
  operations: AccessOperation[];
  pending: AccessPending[];
}

const nameOf = (e: { name: string } | undefined): string => e?.name.trim() || "(名前なし)";

/** そのシステムの操作から、権限表を導く */
export function deriveAccessPolicy(model: UntieModel, systemId: string): AccessPolicy {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const places = usecasePlaces(model);
  const rel = (kind: Relation["kind"]) => model.relations.filter((r) => r.kind === kind);
  const activityUsecase = rel("activityUsecase");
  const actorActivity = rel("actorActivity");
  const eventUsecase = rel("eventUsecase");
  const usecaseInformation = rel("usecaseInformation");
  /** モデルの順に並べる (書き出すたびに順が変わらないように) */
  const order = new Map(model.elements.map((e, i) => [e.id, i]));
  const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const operations: AccessOperation[] = [];
  const pending: AccessPending[] = [];
  const used = new Set<string>();
  for (const u of model.elements) {
    if (u.kind !== "usecase" || places.get(u.id) !== systemId) continue;
    const operation = nameOf(u);
    const activities = activityUsecase.filter((r) => r.targetId === u.id).map((r) => r.sourceId);
    const actors = sorted(actorActivity.filter((r) => activities.includes(r.targetId)).map((r) => r.sourceId)).map((id) => byId.get(id));
    const internal = actors.filter((a) => a?.kind === "actor");
    const external = actors.filter((a) => a?.kind === "externalActor");
    const byEvent = eventUsecase.some((r) => r.targetId === u.id);
    for (const a of internal) used.add(a!.id);

    // 作業に結んだ社外の人は、相手として関わるだけか、自分でこのシステムを使うのかが、分析からは分からない。分かるまでは、行える役割に入れない
    if (external.length > 0) pending.push({ usecaseId: u.id, operation, reason: `社外の「${external.map(nameOf).join("」「")}」が、自分でこの操作を行うのかが決まっていません (行える役割に入れていません)` });
    if (internal.length === 0 && !byEvent) {
      pending.push({ usecaseId: u.id, operation, reason: activities.length === 0 ? "どの作業で行う操作かが決まっていません" : "作業の担当が決まっていません" });
    }
    operations.push({
      id: u.id,
      name: operation,
      allow: internal.map((a) => ({ role: a!.id })),
      byEvent,
      informations: usecaseInformation
        .filter((r) => r.sourceId === u.id && byId.get(r.targetId)?.kind === "information")
        .map((r) => ({ id: r.targetId, name: nameOf(byId.get(r.targetId)), access: r.access ?? "both" })),
    });
  }
  const roles = sorted(used).map((id) => ({ id, name: nameOf(byId.get(id)) }));
  return { format: 1, systemId, system: nameOf(byId.get(systemId)), roles, operations, pending };
}

/** 権限表のファイルの名前 (システムの id から作る) */
export function accessPolicyFileName(systemId: string): string {
  return `${systemId.replace(/[^A-Za-z0-9_-]+/g, "_")}.access.json`;
}

/** 書き出す中身 (JSON) */
export function exportAccessPolicy(model: UntieModel, systemId: string): { fileName: string; text: string; policy: AccessPolicy } {
  const policy = deriveAccessPolicy(model, systemId);
  return { fileName: accessPolicyFileName(systemId), text: `${JSON.stringify(policy, null, 2)}\n`, policy };
}
