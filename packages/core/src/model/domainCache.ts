// ドメインモデルの候補・気づき・システムへのしぼり込みの結果を、直前のモデルの分だけ覚える。
// 分析ボード (イベントストーミング)・設計ボード (ドメイン) の左・中央・右のペインと、ストアの選択の整合が同じ結果を使う (結果は書き換えない)。
import { deriveDomainModel, type DomainDerivation } from "./domainModel";
import { domainNotices, type DomainNotice } from "./domainNotices";
import { buildDomainScope, type DomainScope } from "./domainScope";
import type { UntieModel } from "./types";

let lastModel: { model: UntieModel; derivation: DomainDerivation; notices: DomainNotice[] } | undefined;
let lastScope: { model: UntieModel; systemId: string; scope: DomainScope } | undefined;

/** モデルから導いた候補と気づき (同じモデルなら使い回す) */
export function cachedDomainModel(model: UntieModel): { derivation: DomainDerivation; notices: DomainNotice[] } {
  if (lastModel && lastModel.model === model) return lastModel;
  const derivation = deriveDomainModel(model);
  lastModel = { model, derivation, notices: domainNotices(model, derivation) };
  return lastModel;
}

/** 設計の対象のシステムにしぼった候補 (モデルとシステムが同じなら使い回す) */
export function cachedDomainScope(model: UntieModel, systemId: string | undefined): DomainScope {
  const id = systemId ?? "";
  if (lastScope && lastScope.model === model && lastScope.systemId === id) return lastScope.scope;
  const { derivation, notices } = cachedDomainModel(model);
  const scope = buildDomainScope(model, id, derivation, notices);
  lastScope = { model, systemId: id, scope };
  return scope;
}
