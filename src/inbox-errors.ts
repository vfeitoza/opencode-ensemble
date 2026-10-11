/** Public inbox failure with a semantic kind instead of a guessed message. */
export class InboxAccessError extends Error {
  constructor(public readonly kind: "session_missing" | "invalid_response" | "unauthorized" | "transport", message: string) { super(message); this.name = "InboxAccessError" }
}

/** Only a typed host SessionNotFoundError proves the session no longer exists. */
export function isMissingSession(error: unknown): boolean {
  return error instanceof InboxAccessError ? error.kind === "session_missing" : !!error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError"
}

/** Normalize SDK arrays and HTTP envelopes; malformed input is not an empty inbox. */
export function normalizeInboxResult(value: unknown): { data: Array<{ id: string; type: string; metadata?: Record<string, unknown>; payload?: { text?: string } }> } {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && "data" in value ? value.data : undefined
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || typeof row.id !== "string" || typeof row.type !== "string")) throw new InboxAccessError("invalid_response", "Invalid inbox response; cancellation blocked")
  return { data: rows }
}

/** Preserve typed host errors without interpreting generic 404 text as missing session. */
export function decodeInboxError(value: unknown): InboxAccessError {
  if (isMissingSession(value)) return new InboxAccessError("session_missing", "Session no longer exists")
  const tag = value && typeof value === "object" && "_tag" in value ? value._tag : undefined
  return tag === "UnauthorizedError" ? new InboxAccessError("unauthorized", "Inbox request unauthorized") : new InboxAccessError("transport", "Inbox operation failed; ownership evidence retained")
}
