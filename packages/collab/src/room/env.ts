// ルーム (UntieRoom) が使うバインディング。apps/server の Env はこれを含む。
export interface Env {
  /** ファイルの一覧 (D1)。onSave が名前と更新日時を書く */
  DB: D1Database;
}
