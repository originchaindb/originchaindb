// Compiled against the installed archive before exercising real synthetic rows.
import { OriginChainClient, type SqlDelete } from "@originchain/sdk";
declare const process: { env: Record<string, string | undefined>; exitCode?: number };

async function main() {
  for (const name of ["OC_BASE", "OC_TENANT", "OC_BEARER"]) {
    if (!process.env[name]) throw new Error(`Missing required setting: ${name}`);
  }
  const client = new OriginChainClient({ baseUrl: process.env.OC_BASE!,
    tenantId: process.env.OC_TENANT!, bearer: process.env.OC_BEARER! });
  const namespace = `ts_delete_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const table = `${namespace}.items`;
  await client.registerSchema(`version = 1
namespace = "${namespace}"
table = "items"
primary_key = ["id"]
extractions = []
foreign_keys = []
check_constraints = []
triggers = []
[[columns]]
name = "id"
ty = "str"
required = true
`);
  const checks = { bulk_delete_without_pk: false, empty_delete_count: false };
  try {
    for (const id of ["one", "two"]) {
      await client.sql(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
    }
    const before = await client.sql(`SELECT id FROM ${table}`);
    if (before.kind !== "select" || before.rows.length !== 2) throw new Error("Fixture rows missing");
    const deleted = await client.sql(`DELETE FROM ${table}`);
    if (deleted.kind !== "delete") throw new Error("Expected tagged DELETE result");
    const typed: SqlDelete = deleted;
    if (typed.pk != null || typed.rows_affected !== 2) throw new Error("Unexpected bulk DELETE shape");
    const after = await client.sql(`SELECT id FROM ${table}`);
    if (after.kind !== "select" || after.rows.length !== 0) throw new Error("Deleted rows remain");
    checks.bulk_delete_without_pk = true;
    const empty = await client.sql(`DELETE FROM ${table}`);
    if (empty.kind !== "delete" || empty.pk != null || empty.rows_affected !== 0) {
      throw new Error("Expected zero affected rows for an empty table");
    }
    checks.empty_delete_count = true;
  } finally {
    await client.sql(`DELETE FROM ${table}`);
  }
  console.log(JSON.stringify({ passed: true, checks, scope: "Unique table with synthetic rows only" }));
}
main().catch(() => { console.error("Bulk DELETE live acceptance failed"); process.exitCode = 1; });
