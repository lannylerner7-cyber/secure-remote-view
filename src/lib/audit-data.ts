import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import {
  AUDIT_COLUMNS, AUDIT_CSV_HEADER, AUDIT_EXPORT_BATCH_SIZE, AUDIT_EXPORT_MAX_BYTES,
  AUDIT_EXPORT_MAX_ROWS, AUDIT_PAGE_SIZE, auditCsvFilename, auditCsvRow,
  auditCursorFilter, auditDateBounds, escapeAuditSearch, validateAuditFilters,
  validateAuditTimestamp, type AuditFilters, type AuditRecord,
} from "./audit-report";

type QueryInput = { filters: AuditFilters; snapshot: string; signal?: AbortSignal };
export type AuditPage = { rows: AuditRecord[]; total: number };
export type AuditExportProgress = { completed: number; total: number };

/** Use the signed-in browser client, never a service-role bypass of audit RLS. */
export function createAuditDataSource(client: Pick<SupabaseClient<Database>, "from">) {
  function query(input: QueryInput, counted: boolean) {
    const filters = validateAuditFilters(input.filters);
    const bounds = auditDateBounds(filters);
    const ascending = filters.order === "oldest";
    let request = client.from("audit_logs")
      .select(AUDIT_COLUMNS, counted ? { count: "exact" } : {})
      .lte("created_at", validateAuditTimestamp(input.snapshot))
      .order("created_at", { ascending })
      .order("id", { ascending });
    if (filters.event) request = request.ilike("event", `%${escapeAuditSearch(filters.event)}%`);
    if (filters.deviceId) request = request.eq("device_id", filters.deviceId);
    if (bounds.from) request = request.gte("created_at", bounds.from);
    if (bounds.toExclusive) request = request.lt("created_at", bounds.toExclusive);
    if (input.signal) request = request.abortSignal(input.signal);
    return request;
  }

  async function fetchPage(input: QueryInput & { page?: number }): Promise<AuditPage> {
    const page = input.page ?? 0;
    if (!Number.isSafeInteger(page) || page < 0) throw new Error("Choose a valid report page.");
    const { data, error, count } = await query(input, true)
      .range(page * AUDIT_PAGE_SIZE, (page + 1) * AUDIT_PAGE_SIZE - 1);
    if (error) throw new Error("Audit records could not be loaded. Check your connection and try again.");
    if (count === null) throw new Error("The audit record count is unavailable. Please retry.");
    return { rows: data ?? [], total: count };
  }

  async function exportCsv(input: QueryInput & {
    deviceNames?: Record<string, string>;
    onProgress?: (progress: AuditExportProgress) => void;
  }): Promise<{ csv: string; rowCount: number; filename: string }> {
    const chunks = [AUDIT_CSV_HEADER];
    const encoder = new TextEncoder();
    let bytes = encoder.encode(AUDIT_CSV_HEADER).byteLength;
    let completed = 0;
    let total: number | null = null;
    let cursor: AuditRecord | undefined;
    const seen = new Set<string>();
    for (;;) {
      if (input.signal?.aborted) throw new DOMException("Export cancelled.", "AbortError");
      let request = query(input, total === null);
      if (cursor) request = request.or(auditCursorFilter(cursor, input.filters.order));
      const result = await request.limit(AUDIT_EXPORT_BATCH_SIZE);
      if (input.signal?.aborted) throw new DOMException("Export cancelled.", "AbortError");
      if (result.error) throw new Error("The complete audit report could not be exported. No partial file was downloaded.");
      if (total === null) {
        total = result.count;
        if (total === null) throw new Error("The audit record count is unavailable. Please retry.");
        if (total > AUDIT_EXPORT_MAX_ROWS) {
          throw new Error("This report exceeds 50,000 records. Narrow the date or report filters, then export again.");
        }
        input.onProgress?.({ completed, total });
      }
      const rows = result.data ?? [];
      if (!rows.length) break;
      for (const row of rows) {
        if (seen.has(row.id)) throw new Error("The report changed during export. Refresh and try again.");
        seen.add(row.id);
        const line = auditCsvRow(row, input.deviceNames);
        bytes += encoder.encode(line).byteLength;
        if (bytes > AUDIT_EXPORT_MAX_BYTES) {
          throw new Error("This report exceeds the 32 MB export limit. Narrow the filters and try again.");
        }
        chunks.push(line);
        completed++;
        if (completed > total || completed > AUDIT_EXPORT_MAX_ROWS) {
          throw new Error("The report changed during export. Refresh and try again.");
        }
      }
      cursor = rows[rows.length - 1];
      input.onProgress?.({ completed, total });
      // Do not assume the server's response cap equals our requested batch
      // size. Continue by keyset until the exact count has been collected.
      if (completed === total) break;
    }
    if (completed !== total) {
      throw new Error("The report changed during export. No partial file was downloaded; refresh and try again.");
    }
    return { csv: chunks.join(""), rowCount: completed, filename: auditCsvFilename(input.snapshot) };
  }
  return { fetchPage, exportCsv };
}

export const auditData = createAuditDataSource(supabase);
