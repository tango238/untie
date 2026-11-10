// ドメインモデルの候補・気づき・システムへのしぼり込みの結果を、直前のモデルの分だけ覚える。
// 分析ボード (イベントストーミング)・設計ボード (ドメイン) の左・中央・右のペインと、ストアの選択の整合が同じ結果を使う (結果は書き換えない)。
import { deriveDomainModel, type DomainDerivation } from "./domainModel";
import { domainNotices, type DomainNotice } from "./domainNotices";
import { checkDomain, type DomainCheckProblem } from "./domainCheck";
import { deriveContextMap, type ContextMap } from "./domainMap";
import { resolveDomain, type ResolvedDomain } from "./domainResolve";
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

let lastResolved: { model: UntieModel; systemId: string; resolved: ResolvedDomain } | undefined;

/** 候補に保存した判断を重ねたもの (ドメインボードの左・中央・右のペインが同じ結果を使う) */
export function cachedResolvedDomain(model: UntieModel, systemId: string | undefined): ResolvedDomain {
  const id = systemId ?? "";
  if (lastResolved && lastResolved.model === model && lastResolved.systemId === id) return lastResolved.resolved;
  const resolved = resolveDomain(model, id, cachedDomainScope(model, id), cachedDomainModel(model).derivation);
  lastResolved = { model, systemId: id, resolved };
  return resolved;
}

let lastMap: { model: UntieModel; map: ContextMap; problems: DomainCheckProblem[] } | undefined;

function modelWide(model: UntieModel) {
  if (lastMap && lastMap.model === model) return lastMap;
  const { derivation } = cachedDomainModel(model);
  lastMap = { model, map: deriveContextMap(model, derivation), problems: checkDomain(model, derivation) };
  return lastMap;
}

/** コンテキストマップの下敷き (導いたつながりと保存した関係) */
export function cachedContextMap(model: UntieModel): ContextMap {
  return modelWide(model).map;
}

/** ドメインモデルの検証の結果 */
export function cachedDomainCheck(model: UntieModel): DomainCheckProblem[] {
  return modelWide(model).problems;
}
