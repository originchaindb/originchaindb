import { ProtocolError } from "./sql.js";

export interface FtsHit {
  doc_id: string;
  score: number;
  highlights?: unknown;
  raw?: Record<string, unknown>;
}
export interface FtsResult {
  hits: FtsHit[];
  facets?: unknown;
  raw: unknown;
}
export function decodeFts(value: unknown): FtsResult {
  const envelope = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const items = envelope ? envelope.hits : value;
  if (!Array.isArray(items)) throw new ProtocolError("FTS hits must be an array");
  return { raw: value, facets: envelope?.facets, hits: items.map(item => {
    if (typeof item === "string") return { doc_id: item, score: 0 };
    if (item === null || typeof item !== "object" || Array.isArray(item) || typeof item.doc_id !== "string" ||
        (item.score !== undefined && (typeof item.score !== "number" || !Number.isFinite(item.score))))
      throw new ProtocolError("Invalid FTS hit");
    return { doc_id: item.doc_id, score: item.score ?? 0, highlights: item.highlights, raw: item };
  }) };
}
