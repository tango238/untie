import { applyD1Migrations } from "cloudflare:test";
import { env } from "./helpers";

// 各テストファイルの最初に、D1 へマイグレーション (migrations/*.sql) を当てる
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
