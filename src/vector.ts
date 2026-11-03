import { ProtocolError } from "./sql.js";

export interface VectorHit {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  raw: Record<string, unknown>;
}
export function decodeVector(value: unknown): VectorHit[] {
  if (!Array.isArray(value)) throw new ProtocolError("Vector hits must be an array");
  return value.map(item => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new ProtocolError("Invalid vector hit");
    const id = item.id ?? item.vec_id;
    if (typeof id !== "string" || typeof item.score !== "number" || !Number.isFinite(item.score)) throw new ProtocolError("Invalid vector hit");
    return { id, score: item.score, metadata: item.metadata, raw: item };
  });
}
