/** Read explicit MCP/AG-UI failure flags, never infer failure from human-readable tool text. */
export function isFailedToolResult(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (typeof value === "string") {
    try { return isFailedToolResult(JSON.parse(value), depth + 1); }
    catch { return false; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return envelope.isError === true || isFailedToolResult(envelope.result, depth + 1);
}
