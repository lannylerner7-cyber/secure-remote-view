import type { Json, Tables } from "@/integrations/supabase/types";

export type AuditRecord = Tables<"audit_logs">;
export type AuditFilters = {
  event: string;
  deviceId: string;
  from: string;
  to: string;
  order: "newest" | "oldest";
};

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  event: "", deviceId: "", from: "", to: "", order: "newest",
};
export const AUDIT_PAGE_SIZE = 25;
export const AUDIT_EXPORT_MAX_ROWS = 50_000;
export const AUDIT_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
export const AUDIT_EXPORT_BATCH_SIZE = 500;
export const AUDIT_COLUMNS = "id,actor,created_at,device_id,event,session_id,detail" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateAuditTimestamp(value: string): string {
  if (!TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("The report timestamp is invalid. Refresh the report and try again.");
  }
  // Do not round database timestamps to milliseconds: export cursors need
  // PostgreSQL's original microsecond precision to avoid skipping records.
  return value;
}

export function validateAuditId(value: string): string {
  if (!UUID.test(value)) throw new Error("The device or record identifier is invalid.");
  return value;
}

function utcDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use a valid calendar date.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Use a valid calendar date.");
  }
  return date;
}

export function validateAuditFilters(input: AuditFilters): AuditFilters {
  const filters = { ...input, event: input.event.trim(), deviceId: input.deviceId.trim() };
  if (filters.event.length > 160 || /[\u0000-\u001f]/.test(filters.event)) {
    throw new Error("Search reports using up to 160 characters.");
  }
  if (filters.deviceId) validateAuditId(filters.deviceId);
  if (filters.from) utcDate(filters.from);
  if (filters.to) utcDate(filters.to);
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new Error("The start date must be on or before the end date.");
  }
  if (filters.order !== "newest" && filters.order !== "oldest") {
    throw new Error("Choose a valid report order.");
  }
  return filters;
}

export function auditDateBounds(filters: AuditFilters) {
  const from = filters.from ? utcDate(filters.from).toISOString() : undefined;
  const end = filters.to ? utcDate(filters.to) : undefined;
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  return { from, toExclusive: end?.toISOString() };
}

export function escapeAuditSearch(value: string): string {
  return value.replace(/[\\%_*]/g, "\\$&");
}

export function auditCursorFilter(row: AuditRecord, order: AuditFilters["order"]): string {
  const time = validateAuditTimestamp(row.created_at);
  const id = validateAuditId(row.id);
  const direction = order === "oldest" ? "gt" : "lt";
  return `created_at.${direction}.${time},and(created_at.eq.${time},id.${direction}.${id})`;
}

const CREDENTIAL_KEY = /^code$|password|passphrase|secret|token|credential|authorization|cookie|private.?key|api.?key|pairing.?code(?!.*id$)|access.?code|signed.?url|upload.?url|download.?url|sdp|ice.?servers/i;
const CREDENTIAL_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/-]+=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+|[?&](?:X-Amz-Signature|X-Goog-Signature|token|secret|access_token)=)/i;

/** The same credential redaction is used by the report UI and spreadsheet. */
export function redactAuditDetail(value: Json, depth = 0): Json {
  if (depth > 32) throw new Error("A report contains excessively nested details and cannot be safely exported.");
  if (typeof value === "string") return CREDENTIAL_VALUE.test(value) ? "[REDACTED]" : value;
  if (Array.isArray(value)) return value.map((item) => redactAuditDetail(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, CREDENTIAL_KEY.test(key) ? "[REDACTED]" : redactAuditDetail(item ?? null, depth + 1),
    ]));
  }
  return value;
}

export function auditDetailText(value: Json, pretty = false): string {
  return JSON.stringify(redactAuditDetail(value), null, pretty ? 2 : undefined);
}

export function auditEventLabel(event: string): string {
  return event.replace(/[._-]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** RFC 4180 quoting plus spreadsheet-formula protection for untrusted text. */
export function auditCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(text) ||
      /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export const AUDIT_CSV_HEADER = "\uFEFF" + [
  "Timestamp (UTC)", "Report", "Event", "Actor ID", "Device", "Device ID",
  "Session ID", "Details (JSON)", "Audit ID",
].map(auditCsvCell).join(",") + "\r\n";

export function auditCsvRow(row: AuditRecord, deviceNames: Record<string, string> = {}): string {
  validateAuditTimestamp(row.created_at);
  const fraction = row.created_at.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "000";
  const utcTime = new Date(row.created_at).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`);
  return [
    utcTime, auditEventLabel(row.event), row.event, row.actor,
    row.device_id ? (deviceNames[row.device_id] ?? "") : "",
    row.device_id, row.session_id, auditDetailText(row.detail), row.id,
  ].map(auditCsvCell).join(",") + "\r\n";
}

export function auditCsvFilename(snapshot: string): string {
  return `connectlive-audit-${new Date(validateAuditTimestamp(snapshot)).toISOString().replace(/[:.]/g, "-")}.csv`;
}
