// Compile from a fresh consumer against the installed archive declarations.
import { OriginChainClient, OriginChainAdminClient, type SqlDelete, type SqlResp, type SqlSelect } from "@originchain/sdk";

const legacySelect: SqlSelect = { kind: "select", rows: [] };
const emptyTypedSelect: SqlSelect = {
  kind: "select", rows: [], columns: ["created_at", "amount"],
  column_types: { created_at: "timestamp", amount: "numeric" },
};
async function selectMetadata(client: OriginChainClient): Promise<void> {
  const response = await client.sql("SELECT created_at, amount FROM demo.items");
  if (response.kind !== "select") return;
  const columns: string[] | undefined = response.columns;
  const types: Record<string, string> | undefined = response.column_types;
  // @ts-expect-error Metadata is not guaranteed on older engines.
  const required: Record<string, string> = response.column_types;
  // @ts-expect-error SQL type names are strings, not numeric type identifiers.
  const numericTypes: Record<string, number> | undefined = response.column_types;
  void [columns, types, required, numericTypes];
}
void [legacySelect, emptyTypedSelect, selectMetadata];

const bulk: SqlDelete = { kind: "delete", schema: "demo.items", rows_affected: 2 };
const nullable: SqlDelete = { kind: "delete", schema: "demo.items", pk: null };
const buffered: SqlDelete = { kind: "delete", schema: "demo.items", rows_buffered: 2 };
const single: SqlDelete = { kind: "delete", schema: "demo.items", pk: "one", rows_affected: 1 };
const results: SqlResp[] = [bulk, nullable, buffered, single];
for (const result of results) {
  if (result.kind === "delete") {
    const pk: string | null | undefined = result.pk;
    const count: number | undefined = result.rows_affected;
    const pending: number | undefined = result.rows_buffered;
    // @ts-expect-error A bulk DELETE does not promise a primary key.
    const unsafePk: string = result.pk;
    // @ts-expect-error Counts are numbers, not strings.
    const unsafeCount: string = result.rows_buffered;
    void [pk, count, pending, unsafePk, unsafeCount];
  }
}
async function query(client: OriginChainClient): Promise<SqlDelete> {
  const response = await client.sql("DELETE FROM demo.items");
  if (response.kind !== "delete") throw new Error("Expected DELETE response");
  return response;
}
void query;

// The application path: OC_URL and OC_TOKEN. Never called here; compiled only.
function connect(): OriginChainClient[] {
  const fromEnv: OriginChainClient = OriginChainClient.fromEnv({ timeoutMs: 30_000, env: { OC_URL: "https://db.example.invalid/v1", OC_TOKEN: "t" } });
  const direct = new OriginChainClient({ url: "https://db.example.invalid/v1", token: "t" });
  const address: string = direct.url;
  // @ts-expect-error A client built from url has no tenant: it is never read out of the address.
  const tenant: string = direct.tenantId;
  // @ts-expect-error fromEnv always takes the address from OC_URL.
  void OriginChainClient.fromEnv({ url: "https://db.example.invalid/v1" });
  void [address, tenant];
  return [fromEnv, direct];
}
void connect;

// The removed service must not remain in the installed declaration surface.
// @ts-expect-error Removed public response type.
import type { AskResponse } from "@originchain/sdk";
// @ts-expect-error Removed public request type.
import type { AskRequest } from "@originchain/sdk";
function removed(client: OriginChainClient, admin: OriginChainAdminClient): void {
  // @ts-expect-error Removed database method.
  void client.ask;
  // @ts-expect-error Removed instance proxy method.
  void admin.instances.runAsk;
  // @ts-expect-error No alternate proxy name should expose the removed service.
  void admin.instances.proxiedAsk;
}
void removed;
