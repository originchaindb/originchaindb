import { readFile } from "node:fs/promises";
import { Client, ApiError, BatchError } from "../dist/index.mjs";

async function main() {
  const db = Client.fromEnv();
  // section:setup
  const schema = "sdk_examples.products";
  const toml = await readFile(new URL("./products.toml", import.meta.url), "utf8");
  await db.schemas.register(toml);
  // endsection

  // section:rows
  await db.rows.put(schema, { id: "p2", name: "Gadget", description: "A red gadget" });
  await db.rows.put(schema, {
    id: "p1", name: "Widget", description: "A small blue widget", related_to: "p2",
  });
  const product = await db.rows.get(schema, "p1");
  console.log(product);
  // endsection

  // section:sql
  const result = await db.sql.run(
    "SELECT id, name FROM sdk_examples.products WHERE id = $1", ["p1"],
  );
  for (const row of result.rows) console.log(row.id, row.name);
  // endsection

  // section:vector
  const embedding = [0.1, 0.2, 0.3, 0.4];
  await db.vector.put(schema, "p1", embedding, { category: "tools" });
  const hits = await db.vector.search(schema, embedding, { k: 5 });
  for (const hit of hits) console.log(hit.id, hit.score);
  // endsection

  // section:fts
  await db.fts.index(schema, "description", "p1", "A small blue widget");
  const matches = await db.fts.search(schema, "description", "blue widget", { k: 5 });
  for (const hit of matches.hits) console.log(hit.doc_id, hit.score);
  // endsection

  // section:graph
  const neighbors = await db.graph.neighbors(schema, { pk: "p1", rel: "related" });
  console.log(neighbors);
  // endsection
}

main().catch(error => {
  if (error instanceof BatchError) console.error("Partial batch:", error.result.results.length);
  else if (error instanceof ApiError) console.error("Request failed:", error.status, error.requestId);
  else console.error(error);
  process.exitCode = 1;
});
