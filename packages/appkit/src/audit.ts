// 監査の記録。誰が・どの操作を・どの情報のどの 1 件に・結果はどうだったかを、業務の言葉 (設計の操作と情報の名前) で残す。
// 利用者の名前やメールアドレスは載せない (IdP の利用者の id だけ)。アプリケーションのログ (調査用) とは別のもの。
import type { AccessOperation, Principal } from "./policy";

export interface AuditRecord {
  id: string;
  /** いつ (ISO 8601) */
  at: string;
  /** どのシステムで (システムの id) */
  system: string;
  operation: { id: string; name: string };
  /** 誰が。subject は IdP の利用者の id (システム自身のときは、システムの id)。role は、その操作を行えた役割 */
  actor: { kind: Principal["kind"]; subject: string; role: string | null };
  /** done: 行った。denied: 権限が無く、行わせなかった。failed: 行おうとして、失敗した */
  outcome: "done" | "denied" | "failed";
  /** done のときの、業務としての結果 (ふだんの結果・前提の状態が違う、など。アプリケーションが決める) */
  result?: string;
  /** denied・failed のときの理由 */
  reason?: string;
  /** 操作が扱う情報 (設計から) */
  informations: AccessOperation["informations"];
  /** 対象の 1 件 (情報の id と、その 1 件のキー) */
  targets: { information: string; key: string }[];
  /** 操作の前後の状態 (状態グループの名前 → 状態の名前) */
  before?: Record<string, string>;
  after?: Record<string, string>;
}

/** 記録の置き場所。追記だけをする。業務のデータと同じトランザクションで書くものを、アプリケーションが渡す */
export interface AuditSink {
  append(record: AuditRecord): Promise<void> | void;
}

/** メモリに持つ置き場所 (テストと、データベースをまだ持たないアプリケーション用) */
export function memoryAuditSink(): AuditSink & { readonly records: readonly AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    append(record) {
      records.push(structuredClone(record));
    },
  };
}
