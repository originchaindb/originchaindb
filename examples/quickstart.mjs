import { Client } from "@originchain/sdk";

const db = Client.fromEnv();
const result = await db.sql.run("SELECT $1 AS value", [7]);
console.log(result.rows);
