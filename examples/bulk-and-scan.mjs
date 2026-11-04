// Run against a development database; writes sdk_iteration.items.
import { readFile } from "node:fs/promises";
import { Client } from "../dist/index.mjs";

const db = Client.fromEnv();
const schema = "sdk_iteration.items";
await db.schemas.register(await readFile(new URL("./items.toml", import.meta.url), "utf8"));
function* input() {
  for (const id of "abcde") yield { id, name: `Item ${id}` };
}
const rows = input();
// section:bulk
for await (const batch of db.rows.writeBatches(schema, rows, { batchSize: 2 })) {
  console.log(batch.offset, batch.count, batch.inserted);
}
// endsection
// section:scan
for await (const row of db.rows.scan(schema, "id", { pageSize: 2 })) {
  console.log(row.id, row.name);
}
// endsection
// Save a checkpoint after successfully processing the complete page.
for await (const page of db.rows.pages(schema, "id", { pageSize: 2, after: "b" })) {
  for (const row of page.rows) console.log("resumed", row.id);
  console.log("next cursor", page.nextCursor);
}
