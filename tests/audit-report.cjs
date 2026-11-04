// Isolated audit query/CSV regression checks. No network or real audit records.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const app = fs.existsSync(path.join(root, "src")) ? path.join(root, ".") : root;
const req = createRequire(path.join(app, "package.json"));
const ts = req("typescript");
function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(app, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Date, JSON, Set, TextEncoder, DOMException,
    require(id) { assert.ok(Object.hasOwn(deps, id), `Unexpected import ${id}`); return deps[id]; },
  });
  return module.exports;
}
const report = load("src/lib/audit-report.ts");
const { createAuditDataSource } = load("src/lib/audit-data.ts", {
  "./audit-report": report, "@/integrations/supabase/client": { supabase: {} },
});
const uuid = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;
const records = Array.from({ length: 1203 }, (_, i) => ({
  id: uuid(i + 1), actor: uuid(9000), created_at: "2026-11-04T10:00:00.123456+00:00",
  event: "session.opened", device_id: uuid(8000), session_id: null,
  detail: { note: 'Lagos – café, "quoted"\nsecond line', nested: { api_key: "synthetic-secret" }, code: "000000" },
}));
const input = {
  filters: { ...report.DEFAULT_AUDIT_FILTERS }, snapshot: "2026-11-04T23:59:59.999Z",
};
function client(rows, options = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, "audit_logs");
      let count = false, ascending = false, size = 73, offset = 0, cursor;
      return {
        select(columns, opts) { assert.equal(columns, report.AUDIT_COLUMNS); count = opts.count === "exact"; return this; },
        lte(column, value) { calls.push([column, "lte", value]); return this; },
        gte(column, value) { calls.push([column, "gte", value]); return this; },
        lt(column, value) { calls.push([column, "lt", value]); return this; },
        eq(column, value) { calls.push([column, "eq", value]); return this; },
        ilike(column, value) { calls.push([column, "ilike", value]); return this; },
        order(column, opts) { ascending = opts.ascending; return this; },
        range(start, end) { offset = start; size = end - start + 1; return this; },
        limit(n) { size = Math.min(n, 73); return this; }, // Simulate a lower server cap.
        abortSignal() { return this; },
        or(value) {
          assert.ok(value.includes("10:00:00.123456+00:00"), "Cursor lost timestamp precision");
          cursor = value.match(/id\.(?:lt|gt)\.([0-9a-f-]+)/)[1];
          return this;
        },
        then(resolve, reject) {
          let sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id) * (ascending ? 1 : -1));
          if (cursor) sorted = sorted.filter((r) => ascending ? r.id > cursor : r.id < cursor);
          return Promise.resolve({
            data: sorted.slice(offset, offset + size),
            count: count ? (options.total ?? rows.length) : null,
            error: options.error ?? null,
          }).then(resolve, reject);
        },
      };
    },
  };
}
function parseCsv(csv) {
  const rows = []; let row = [], cell = "", quoted = false;
  csv = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if (c === "\r" && csv[i + 1] === "\n" && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ""; i++;
    } else cell += c;
  }
  assert.equal(quoted, false); return rows;
}
(async () => {
  const source = client(records);
  const data = createAuditDataSource(source);
  const page = await data.fetchPage({ ...input, page: 1 });
  assert.equal(page.rows.length, 25); assert.equal(page.total, 1203);
  assert.equal(page.rows[0].id, uuid(1178));
  const exported = await data.exportCsv({
    ...input, deviceNames: { [uuid(8000)]: '=HYPERLINK("https://example.invalid","unsafe")' },
  });
  const parsed = parseCsv(exported.csv);
  assert.equal(parsed.length, 1204); assert.equal(exported.rowCount, 1203);
  assert.equal(new Set(parsed.slice(1).map((r) => r[8])).size, 1203);
  assert.equal(parsed[1][0], "2026-11-04T10:00:00.123456Z");
  assert.ok(parsed[1][4].startsWith("'="));
  assert.equal(JSON.parse(parsed[1][7]).note, records[0].detail.note);
  assert.equal(JSON.parse(parsed[1][7]).nested.api_key, "[REDACTED]");
  assert.equal(JSON.parse(parsed[1][7]).code, "[REDACTED]");
  assert.ok(exported.csv.startsWith("\uFEFF"));
  assert.match(exported.filename, /^connectlive-audit-.*\.csv$/);
  const oldest = await data.exportCsv({ ...input, filters: { ...input.filters, order: "oldest" } });
  assert.equal(parseCsv(oldest.csv)[1][8], uuid(1));
  for (const value of ["=1+1", "+cmd", "-cmd", "@SUM(A1)", " \t=1", "\r=1", "＝1"]) {
    assert.ok(report.auditCsvCell(value).startsWith("\"'"), `Unsafe cell ${JSON.stringify(value)}`);
  }
  const filteredClient = client([]);
  await createAuditDataSource(filteredClient).fetchPage({
    ...input, filters: { ...input.filters, event: "session_%", deviceId: uuid(8000), from: "2026-11-01", to: "2026-11-04" },
  });
  assert.ok(filteredClient.calls.some((c) => c[0] === "event" && c[2] === "%session\\_\\%%"));
  assert.ok(filteredClient.calls.some((c) => c[0] === "created_at" && c[1] === "lt" && c[2] === "2026-11-05T00:00:00.000Z"));
  assert.throws(() => report.validateAuditFilters({ ...input.filters, from: "2026-02-30" }));
  assert.throws(() => report.validateAuditFilters({ ...input.filters, from: "2026-11-05", to: "2026-11-04" }));
  assert.throws(() => report.validateAuditFilters({ ...input.filters, deviceId: "not-a-uuid" }));
  await assert.rejects(createAuditDataSource(client([], { total: 50001 })).exportCsv(input), /50,000/);
  await assert.rejects(createAuditDataSource(client(records.slice(0, 1), { total: 2 })).exportCsv(input), /No partial file/);
  await assert.rejects(createAuditDataSource(client([], { error: { message: "offline" } })).exportCsv(input), /No partial file/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(data.exportCsv({ ...input, signal: abort.signal }), { name: "AbortError" });
  const offsetRow = { ...records[0], created_at: "2026-11-04T12:00:00.123456+02:00" };
  assert.ok(report.auditCsvRow(offsetRow).startsWith('"2026-11-04T10:00:00.123456Z"'));
  console.log("PASS: audit paging, complete 1,203-row export under a lower server cap, both orders, UTC precision, CSV round-trip, filters, redaction, formulas, cancellation and explicit failure boundaries.");
})().catch((e) => { console.error(e); process.exitCode = 1; });
