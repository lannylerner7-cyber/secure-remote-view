// Read-only schema snapshot: no application rows or credentials are exported.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { Client } = createRequire(path.resolve("lib/db/package.json"))("pg");
const { connectionOptions } = require("./supabase-fresh-install.cjs");
(async () => {
  const client = new Client(connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL));
  try {
    await client.connect();
    const triggers = (await client.query(
      "SELECT pg_get_triggerdef(oid) definition,tgfoid::regprocedure::text func FROM pg_trigger WHERE tgrelid='public.sessions'::regclass AND NOT tgisinternal ORDER BY tgname")).rows;
    let sql = "";
    const functions = new Set(["has_role(uuid,public.app_role)", "valid_authorization_request(jsonb)",
      "session_authorized(uuid,text)", ...triggers.map(t => t.func)]);
    for (const name of functions) sql += (await client.query(
      "SELECT pg_get_functiondef($1::regprocedure) d", [name])).rows[0].d + ";\n";
    for (const trigger of triggers) sql += trigger.definition + ";\n";
    const policies = (await client.query("SELECT policyname,cmd,qual,with_check,roles::text[] roles FROM pg_policies WHERE schemaname='public' AND tablename='sessions'")).rows;
    sql += "ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;\n";
    const quote = s => '"' + s.replaceAll('"', '""') + '"';
    for (const p of policies) {
      sql += `CREATE POLICY ${quote(p.policyname)} ON public.sessions FOR ${p.cmd} TO ${p.roles.map(quote).join(",")}`;
      if (p.qual) sql += ` USING (${p.qual})`;
      if (p.with_check) sql += ` WITH CHECK (${p.with_check})`;
      sql += ";\n";
    }
    fs.writeFileSync(process.argv[2], sql);
    console.log(`Captured ${triggers.length} actual session triggers and ${policies.length} RLS policies; no application data.`);
  } finally { await client.end(); }
})().catch(e => { console.error("Schema snapshot failed:", e.code || e.name); process.exitCode = 1; });
