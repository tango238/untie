import { effectiveDatabaseIds } from "@untie/core/model/design";
import type { Database, UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";

/** データボードで選んでいるデータベース。選んでいない (または無くなった) ときは、既定の規則で使われるデータベースか先頭 */
export function selectedDatabaseOf(model: UntieModel, systemId: string | undefined, selectedId: string | undefined): Database | undefined {
  const picked = selectedId === undefined ? undefined : model.databases.find((d) => d.id === selectedId);
  if (picked) return picked;
  const design = model.designs.find((d) => d.systemId === systemId);
  const first = effectiveDatabaseIds(model, design ?? { databaseIds: [] })[0];
  return model.databases.find((d) => d.id === first) ?? model.databases[0];
}

/** データボードの 3 つのペインが共有する選択 (対象のシステム・データベース・テーブル) */
export function useDataSelection() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const databaseId = useUntieStore((s) => s.ui.designDatabaseId);
  const tableName = useUntieStore((s) => s.ui.designTableName);
  const database = selectedDatabaseOf(model, systemId, databaseId);
  return { model, systemId, database, tableName: database && databaseId === database.id ? tableName : undefined };
}
