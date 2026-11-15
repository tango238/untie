// 権限の判定。untie が設計から書き出した権限表 (<システムの id>.access.json) を引くだけで、規則は持たない。
// 表の形は、untie の deriveAccessPolicy (packages/core/src/model/accessPolicy.ts) が作るものと同じ

/** 操作を行える役割。own が true なら、本人のもの (対象の持ち主が、ログインしている本人) に限る */
export interface AccessAllow {
  role: string;
  own?: true;
}

export interface AccessOperation {
  id: string;
  name: string;
  /** 行える役割。空なら、人は行えない */
  allow: AccessAllow[];
  /** 出来事をきっかけに、システムが行うことがある */
  byEvent: boolean;
  /** 扱う情報 (監査の記録に載せる) */
  informations: { id: string; name: string; access: "read" | "write" | "both" }[];
}

export interface AccessPolicy {
  format: 1;
  systemId: string;
  system: string;
  roles: { id: string; name: string }[];
  operations: AccessOperation[];
}

/** 操作を行う者。user はログインしている人、system は出来事をきっかけに動くシステム自身 */
export type Principal = { kind: "user"; subject: string; roles: string[] } | { kind: "system"; subject: string; roles: [] };

/** 出来事をきっかけにした操作を行うときの、システム自身 */
export function systemPrincipal(systemId: string): Principal {
  return { kind: "system", subject: systemId, roles: [] };
}

/** 操作の対象。owner は持ち主 (ログインしている人の subject と比べる)。新しく作るものは、作る本人を入れる */
export interface AccessTarget {
  owner?: string;
}

export type AccessDecision = { allowed: true; role: string | null } | { allowed: false; reason: "noRole" | "notOwner" | "notByEvent" };

/** 表の中の操作を引く。無い操作は、設計に無いものを呼んでいるので、エラーにする (黙って通さない・黙って断らない) */
export function findOperation(policy: AccessPolicy, operationId: string): AccessOperation {
  const operation = policy.operations.find((o) => o.id === operationId);
  if (!operation) throw new Error(`権限表に無い操作です: ${operationId} (${policy.systemId})`);
  return operation;
}

/** その者が、その操作を行えるか */
export function decide(operation: AccessOperation, principal: Principal, target?: AccessTarget): AccessDecision {
  if (principal.kind === "system") return operation.byEvent ? { allowed: true, role: null } : { allowed: false, reason: "notByEvent" };
  const mine = operation.allow.filter((a) => principal.roles.includes(a.role));
  if (mine.length === 0) return { allowed: false, reason: "noRole" };
  // 本人のものに限らない役割を、先に見る (両方を持つ人は、広いほうで通る)
  const open = mine.find((a) => !a.own);
  if (open) return { allowed: true, role: open.role };
  const isOwner = target?.owner !== undefined && target.owner === principal.subject;
  return isOwner ? { allowed: true, role: mine[0]!.role } : { allowed: false, reason: "notOwner" };
}
