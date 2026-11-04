import { Client, mapRows } from "@originchain/sdk";

const db = Client.fromEnv({
  // Replace with your application's current credential cache when needed.
  tokenProvider: () => process.env.OC_TOKEN,
  onRequest: event => console.log(event.operation, event.status, event.durationMs),
  // Supply a configured fetch implementation here for proxy/TLS requirements.
  fetch: globalThis.fetch,
});
const result = await db.sql.run("SELECT $1 AS id, $2 AS name", ["p1", "Widget"]);
const products = mapRows(result, row => {
  if (typeof row.id !== "string" || typeof row.name !== "string")
    throw new TypeError("Product requires string id and name");
  return { id: row.id, name: row.name };
});
console.log(products);
