// 操作の入口。生成したアプリケーションは、設計の操作を 1 つ行うたびに、ここを 1 回通る。
// 権限の判定 → 処理 → 監査の記録を、必ずこの順で行うので、どれかを書き忘れることがない。
import type { AuditRecord, AuditSink } from "./audit";
import { AuditError, ForbiddenError } from "./errors";
import { decide, findOperation, type AccessPolicy, type AccessTarget, type Principal } from "./policy";

export interface OperationInput {
  principal: Principal;
  /** 操作の id (設計の操作の id) */
  operation: string;
  /** 操作の対象の持ち主 (本人のものに限る役割の判定に使う) */
  target?: AccessTarget;
  /** この 1 回だけ使う、記録の置き場所 (業務のデータと同じトランザクションに結んだもの)。省略は、既定の置き場所 */
  audit?: AuditSink;
}

/** 処理の中から、監査の記録に載せるものを足す (何度呼んでもよい。あとのものが上書きする) */
export interface OperationContext {
  principal: Principal;
  record(detail: Partial<Pick<AuditRecord, "result" | "targets" | "before" | "after">>): void;
}

export interface OperationsOptions {
  policy: AccessPolicy;
  audit: AuditSink;
  /** いまの時刻と、記録の id の作り方 (テストで固定するため) */
  now?: () => Date;
  newId?: () => string;
}

export interface Operations {
  run<T>(input: OperationInput, fn: (ctx: OperationContext) => Promise<T> | T): Promise<T>;
}

export function createOperations(options: OperationsOptions): Operations {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  return {
    async run<T>(input: OperationInput, fn: (ctx: OperationContext) => Promise<T> | T): Promise<T> {
      const operation = findOperation(options.policy, input.operation);
      const sink = input.audit ?? options.audit;
      const decision = decide(operation, input.principal, input.target);
      const base = (): Omit<AuditRecord, "outcome"> => ({
        id: newId(),
        at: now().toISOString(),
        system: options.policy.systemId,
        operation: { id: operation.id, name: operation.name },
        actor: { kind: input.principal.kind, subject: input.principal.subject, role: decision.allowed ? decision.role : null },
        informations: operation.informations,
        targets: [],
      });
      const append = async (record: AuditRecord) => {
        try {
          await sink.append(record);
        } catch (cause) {
          throw new AuditError({ cause });
        }
      };

      if (!decision.allowed) {
        await append({ ...base(), outcome: "denied", reason: decision.reason });
        throw new ForbiddenError(decision.reason);
      }
      let detail: Partial<Pick<AuditRecord, "result" | "targets" | "before" | "after">> = {};
      const ctx: OperationContext = { principal: input.principal, record: (d) => void (detail = { ...detail, ...d }) };
      let value: T;
      try {
        value = await fn(ctx);
      } catch (error) {
        // 失敗も記録する。理由には、エラーの種類だけを載せる (メッセージには、入力された値が入りうる)
        await append({ ...base(), ...detail, outcome: "failed", reason: error instanceof Error ? error.name : "Error" });
        throw error;
      }
      await append({ ...base(), ...detail, outcome: "done" });
      return value;
    },
  };
}
