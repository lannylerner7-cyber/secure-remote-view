#!/usr/bin/env node
'use strict';

// Metadata only. Importing the installer exposes reviewed parsing/TLS helpers;
// its CLI, preflight (which reads application data), and apply paths never run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const ts = require('typescript');
const { buildPlan, connectionOptions } = require('./supabase-fresh-install.cjs');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'imports/connectlive');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const TABLES = 'admin_settings admin_wallets audit_logs contact_messages cron_tokens device_authorizations devices expected_devices license_lookups licenses login_attempts newsletter_subscribers notifications order_emails orders payment_events payment_quote_reservations plans portal_settings power_commands profiles releases session_cursors session_files session_frames session_inputs session_secrets session_signals session_telemetry sessions smtp_settings support_bookings user_roles'.split(' ');
const SERVER_ONLY = 'cron_tokens session_secrets smtp_settings login_attempts payment_quote_reservations device_authorizations'.split(' ');
function files(dir, extension) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    ['node_modules', 'bin', 'obj', '.git'].includes(e.name) ? [] :
      e.isDirectory() ? files(path.join(dir, e.name), extension) :
        extension.test(e.name) ? [path.join(dir, e.name)] : []);
}
function member(node, name) { return node?.members?.find(m => m.name?.getText().replaceAll('"', '') === name)?.type; }
function members(node) { return node?.members || []; }
function literal(node) { return node && ts.isStringLiteral(node) ? node.text : null; }
function sourceContracts() {
  const text = fs.readFileSync(path.join(app, 'src/integrations/supabase/types.ts'), 'utf8');
  const tree = ts.createSourceFile('types.ts', text, ts.ScriptTarget.Latest, true);
  const db = tree.statements.find(s => ts.isTypeAliasDeclaration(s) && s.name.text === 'Database');
  const schema = member(db.type, 'public');
  const tables = members(member(schema, 'Tables')).map(m => ({
    name: m.name.getText(),
    columns: members(member(m.type, 'Row')).map(c => ({
      name: c.name.getText(), type: c.type.getText(), nullable: /\bnull\b/.test(c.type.getText()),
      optionalInsert: !!members(member(m.type, 'Insert')).find(i => i.name.getText() === c.name.getText())?.questionToken,
    })),
    relationships: (member(m.type, 'Relationships')?.elements || []).map(r => ({
      name: literal(member(r, 'foreignKeyName')?.literal),
      columns: (member(r, 'columns')?.elements || []).map(c => literal(c.literal)),
      referencedTable: literal(member(r, 'referencedRelation')?.literal),
      referencedColumns: (member(r, 'referencedColumns')?.elements || []).map(c => literal(c.literal)),
      oneToOne: member(r, 'isOneToOne')?.getText() === 'true',
    })),
  }));
  const enums = members(member(schema, 'Enums')).map(e => ({
    name: e.name.getText(), labels: [...e.type.getText().matchAll(/"([^"]+)"/g)].map(x => x[1]),
  }));
  const columns = new Set(), from = new Set(), rpc = new Set(), realtime = new Set();
  function tableOf(n) {
    if (!n || !ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return null;
    if (n.expression.name.text === 'from') {
      // Storage bucket calls are not PostgREST table calls.
      if (/\.storage$/.test(n.expression.expression.getText())) return null;
      return literal(n.arguments[0]);
    }
    return tableOf(n.expression.expression);
  }
  for (const file of files(path.join(app, 'src'), /\.(ts|tsx)$/)) {
    if (file.endsWith('/types.ts')) continue;
    const s = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(n) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text, arg = literal(n.arguments[0]), table = tableOf(n);
        if (method === 'from' && table) from.add(table);
        if (method === 'rpc' && arg) rpc.add(arg);
        if (table && arg && ['select', 'eq', 'neq', 'in', 'is', 'order', 'gt', 'gte', 'lt', 'lte'].includes(method)) {
          for (const c of arg.split(',')) if (/^[a-z_][a-z0-9_]*$/.test(c.trim())) columns.add(`${table}.${c.trim()}`);
        }
        if (table && ['insert', 'upsert', 'update'].includes(method) && n.arguments[0]) {
          const objects = ts.isArrayLiteralExpression(n.arguments[0]) ? n.arguments[0].elements : [n.arguments[0]];
          for (const o of objects) if (ts.isObjectLiteralExpression(o)) {
            for (const p of o.properties) if (p.name && /^[a-z_][a-z0-9_]*$/.test(p.name.getText())) columns.add(`${table}.${p.name.getText()}`);
          }
        }
      }
      if (ts.isObjectLiteralExpression(n) && n.properties.some(p => p.name?.getText() === 'schema' && literal(p.initializer) === 'public')) {
        const t = n.properties.find(p => p.name?.getText() === 'table');
        if (literal(t?.initializer)) realtime.add(literal(t.initializer));
      }
      ts.forEachChild(n, visit);
    }
    visit(s);
  }
  let nativeSelectors = 0;
  for (const dir of ['agent/src', 'admin/src']) for (const file of files(path.join(app, dir), /\.cs$/)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\/rest\/v1\/([a-z_]+)\?select=([a-z_,*]+)/g)) {
      from.add(m[1]); nativeSelectors++;
      for (const c of m[2].split(',')) if (c !== '*') columns.add(`${m[1]}.${c}`);
    }
    for (const m of text.matchAll(/\/rest\/v1\/rpc\/([a-z_]+)/g)) rpc.add(m[1]);
  }
  return { tables, enums, columns, from, rpc, realtime, nativeSelectors };
}

// Intentionally identical catalog projection/order to the installed provenance
// checksum. It reads definitions/ACLs only, never application or auth rows.
async function fingerprint(client) {
  const { rows } = await client.query(`
    SELECT kind, name, definition FROM (
      SELECT 'relation' kind, c.relname name,
        jsonb_build_array(c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl,c.relreplident) definition
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
      UNION ALL SELECT 'column', c.relname||'.'||a.attname,
        jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attacl)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT 'constraint', c.relname||'.'||k.conname, to_jsonb(pg_get_constraintdef(k.oid))
        FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL SELECT 'index', indexname, to_jsonb(indexdef) FROM pg_indexes WHERE schemaname='public'
      UNION ALL SELECT 'function', p.oid::regprocedure::text, jsonb_build_array(pg_get_functiondef(p.oid),p.proacl,p.proowner)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
      UNION ALL SELECT 'policy', schemaname||'.'||tablename||'.'||policyname, to_jsonb(p)
        FROM pg_policies p WHERE schemaname='public' OR (schemaname='storage' AND tablename='objects')
      UNION ALL SELECT 'trigger', n.nspname||'.'||c.relname||'.'||t.tgname, to_jsonb(pg_get_triggerdef(t.oid))
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE NOT t.tgisinternal AND (n.nspname='public' OR (n.nspname='auth' AND c.relname='users'))
      UNION ALL SELECT 'enum', t.typname||'.'||e.enumsortorder, to_jsonb(e.enumlabel)
        FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
      UNION ALL SELECT 'publication', pubname||'.'||schemaname||'.'||tablename, to_jsonb(p)
        FROM pg_publication_tables p WHERE schemaname='public'
    ) x ORDER BY kind,name,definition::text`);
  return hash(JSON.stringify(rows));
}
async function verify(client, source, plan) {
  const checks = [], gaps = [], warnings = [];
  const check = (name, ok, detail) => { checks.push({ name, status: ok ? 'PASS' : 'GAP', ...detail }); if (!ok) gaps.push(name); };
  const query = async (sql, params) => (await client.query(sql, params)).rows;
  const tables = await query(`SELECT c.relname name,c.relrowsecurity rls FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY 1`);
  check('public table inventory', JSON.stringify(tables.map(t => t.name)) === JSON.stringify(TABLES), { count: tables.length });
  check('RLS enabled on every public table', tables.every(t => t.rls), { count: tables.filter(t => t.rls).length });
  const columns = await query(`SELECT c.relname table_name,a.attname name,t.typname type,a.attnotnull required,
    d.oid IS NOT NULL has_default FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`);
  const liveColumns = new Map(columns.map(c => [`${c.table_name}.${c.name}`, c]));
  const missingSourceColumns = [...source.columns].filter(c => !liveColumns.has(c));
  check('literal web/native source columns', missingSourceColumns.length === 0, { checked: source.columns.size, missing: missingSourceColumns, nativeSelectors: source.nativeSelectors });
  check('literal source table references', [...source.from].every(t => tables.some(l => l.name === t)), { checked: source.from.size, missing: [...source.from].filter(t => !tables.some(l => l.name === t)) });
  const missingTypedTables = TABLES.filter(t => !source.tables.some(s => s.name === t));
  const typeDifferences = [];
  for (const table of source.tables) for (const col of table.columns) {
    const key = `${table.name}.${col.name}`, live = liveColumns.get(key);
    if (!live) { typeDifferences.push(`${key}: missing live`); continue; }
    if (col.nullable !== !live.required) typeDifferences.push(`${key}: nullability`);
    if (col.optionalInsert !== (!live.required || live.has_default)) typeDifferences.push(`${key}: Insert optionality`);
    const expected = live.type === 'bool' ? 'boolean' : /^(int[248]|float[48]|numeric)$/.test(live.type) ? 'number' :
      /^jsonb?$/.test(live.type) ? 'Json' : live.type === 'app_role' ? 'Enums' : 'string';
    if (!col.type.includes(expected)) typeDifferences.push(`${key}: type`);
  }
  const untypedColumns = columns.filter(c => source.tables.some(t => t.name === c.table_name) &&
    !source.tables.find(t => t.name === c.table_name).columns.some(col => col.name === c.name)).map(c => `${c.table_name}.${c.name}`);
  check('generated table/column types', !missingTypedTables.length && !typeDifferences.length && !untypedColumns.length,
    { typedTables: source.tables.length, liveColumns: columns.length, missingTypedTables, untypedColumns, differences: typeDifferences });
  const enums = await query(`SELECT t.typname name,array_agg(e.enumlabel::text ORDER BY e.enumsortorder) labels
    FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' GROUP BY t.typname ORDER BY 1`);
  check('public enum names/order/labels', JSON.stringify(enums) === JSON.stringify(source.enums), { count: enums.length });
  const fks = await query(`SELECT k.conname name,c.relname table_name,r.relname referenced_table,
    rn.nspname referenced_schema,k.convalidated valid,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(n,i)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.n ORDER BY x.i) columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(n,i)
      JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.n ORDER BY x.i) referenced_columns,
    EXISTS(SELECT 1 FROM pg_constraint u WHERE u.conrelid=k.conrelid
      AND u.contype IN ('u','p') AND u.conkey=k.conkey) one_to_one FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class r ON r.oid=k.confrelid JOIN pg_namespace rn ON rn.oid=r.relnamespace
    WHERE n.nspname='public' AND k.contype='f' ORDER BY 1`);
  check('foreign key constraints validated', fks.every(f => f.valid), { count: fks.length });
  const missingTypedRelationships = fks.filter(f => f.referenced_schema === 'public' &&
    !source.tables.find(t => t.name === f.table_name)?.relationships.some(r => r.name === f.name &&
      r.referencedTable === f.referenced_table && r.oneToOne === f.one_to_one &&
      JSON.stringify(r.columns) === JSON.stringify(f.columns) &&
      JSON.stringify(r.referencedColumns) === JSON.stringify(f.referenced_columns))).map(f => `${f.table_name}.${f.name}`);
  const extraTypedRelationships = source.tables.flatMap(t => t.relationships.filter(r =>
    !fks.some(f => f.table_name === t.name && f.name === r.name)).map(r => `${t.name}.${r.name}`));
  check('generated public foreign key relationships', !missingTypedRelationships.length && !extraTypedRelationships.length,
    { checked: fks.filter(f => f.referenced_schema === 'public').length, missingOrDifferent: missingTypedRelationships, extra: extraTypedRelationships });
  const routines = await query(`SELECT p.proname name,p.oid::regprocedure::text signature,p.prosecdef definer,p.proconfig config
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'`);
  check('literal source RPC routines', [...source.rpc].every(r => routines.some(l => l.name === r)), {
    checked: source.rpc.size, missing: [...source.rpc].filter(r => !routines.some(l => l.name === r)) });
  const authRoutines = ['session_authorized(uuid,text)', 'device_authorization(uuid)', 'record_device_authorization(uuid,jsonb)',
    'revoke_device_authorization(uuid)', 'storage_session_authorized(text)', 'session_safety_access(uuid)', 'bind_admin(uuid,text)'];
  const routineChecks = [];
  for (const signature of authRoutines) {
    const r = routines.find(r => r.signature.replace(/^public\./, '') === signature);
    if (!r) { routineChecks.push(false); continue; }
    const privileges = (await query(`SELECT has_function_privilege('anon',$1,'EXECUTE') anon,
      has_function_privilege('authenticated',$1,'EXECUTE') authenticated,
      has_function_privilege('service_role',$1,'EXECUTE') service`, [`public.${signature}`]))[0];
    const serviceOnly = /^(device_authorization|record_device_authorization|revoke_device_authorization)\(/.test(signature);
    routineChecks.push(r.definer && r.config?.includes('search_path=public') && !privileges.anon &&
      privileges.authenticated === !serviceOnly && privileges.service === !signature.startsWith('bind_admin('));
  }
  check('authorization/binding routine security and execute grants', routineChecks.every(Boolean), { checked: routineChecks.length });
  const policies = await query(`SELECT schemaname,tablename,policyname,permissive,roles,qual,with_check
    FROM pg_policies WHERE schemaname IN ('public','storage') ORDER BY schemaname,tablename,policyname`);
  const restrictive = [['session_frames','recorded_frames'], ['session_cursors','recorded_cursors'],
    ['session_signals','recorded_signals'], ['session_inputs','recorded_inputs'], ['session_files','recorded_files'],
    ['objects','recorded_storage'], ['objects','connectlive_session_files_anon_deny']];
  check('restrictive authorization/storage policies', restrictive.every(([t,p]) => policies.some(l =>
    l.tablename === t && l.policyname === p && l.permissive === 'RESTRICTIVE' && l.qual && l.with_check)), { checked: restrictive.length, totalPolicies: policies.length });
  check('server-only tables have no client policies', !policies.some(p => SERVER_ONLY.includes(p.tablename) &&
    p.roles.some(r => ['public','anon','authenticated'].includes(r))), { checked: SERVER_ONLY.length });
  const privateGrants = [];
  for (const table of SERVER_ONLY) privateGrants.push((await query(`SELECT
    NOT has_table_privilege('anon',$1,'SELECT,INSERT,UPDATE,DELETE') AND
    NOT has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE') ok`, [`public.${table}`]))[0].ok);
  // RLS can protect server-only relations even where historical client table grants remain.
  if (!privateGrants.every(Boolean)) warnings.push({
    name: 'server-only tables retain historical client table privileges, but have no client RLS policies',
    count: privateGrants.filter(ok => !ok).length,
    tables: SERVER_ONLY.filter((_, i) => !privateGrants[i]),
  });
  const authPrivate = (await query(`SELECT NOT has_table_privilege('authenticated','public.device_authorizations','SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('anon','public.device_authorizations','SELECT,INSERT,UPDATE,DELETE') ok`))[0].ok;
  check('device_authorizations private grants', authPrivate);
  const serviceGrants = [];
  for (const table of TABLES) serviceGrants.push((await query(`SELECT bool_and(has_table_privilege('service_role',$1,p)) ok
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`, [`public.${table}`]))[0].ok);
  check('service-role CRUD grants', serviceGrants.every(Boolean), { checked: TABLES.length });
  const triggers = await query(`SELECT c.relname table_name,t.tgname name,t.tgenabled enabled FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal`);
  const guardTables = ['session_frames','session_cursors','session_signals','session_inputs','session_files','session_secrets'];
  check('enabled lifecycle and channel triggers', [['sessions','guard_recorded_session_authority'],
    ['sessions','guard_client_session_transitions'], ['devices','guard_device_credentials'],
    ...guardTables.map(t => [t,'guard_live_channel_write'])].every(([table,name]) =>
    triggers.some(t => t.table_name === table && t.name === name && ['O','A'].includes(t.enabled))), { checked: 9 });
  const indexes = await query(`SELECT c.relname name,i.indisvalid valid,i.indisready ready
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`);
  const requiredIndexes = ['devices_status_last_seen_idx','devices_license_idx','sessions_device_state_idx','sessions_device_created_idx',
    'sessions_technician_created_idx','idx_sessions_tech_state','session_inputs_session_seq_idx','idx_session_signals_routing',
    'ux_session_signals_attempt','ix_session_files_session','idx_session_frames_session','idx_session_cursors_session',
    'one_current_device_authorization','expected_devices_claim_code_uq','idx_power_commands_device_queue_expiry'];
  check('device/session request indexes', requiredIndexes.every(name => indexes.some(i => i.name === name && i.valid && i.ready)),
    { checked: requiredIndexes.length, total: indexes.length, missing: requiredIndexes.filter(name => !indexes.some(i => i.name === name && i.valid && i.ready)) });
  const publication = await query(`SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' ORDER BY 1`);
  const requiredRealtime = new Set([...source.realtime, 'devices','sessions','session_frames','session_cursors','session_signals','power_commands','notifications']);
  check('realtime source subscriptions', [...requiredRealtime].every(t => publication.some(p => p.tablename === t)),
    { published: publication.length, required: requiredRealtime.size, missing: [...requiredRealtime].filter(t => !publication.some(p => p.tablename === t)) });
  const bucket = await query(`SELECT public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='session-files' AND name='session-files'`);
  check('private session-files bucket', bucket.length === 1 && bucket[0].public === false &&
    Number(bucket[0].file_size_limit) === 524288000 && bucket[0].allowed_mime_types === null, { count: bucket.length, expectedFileBytes: 524288000 });
  const history = await query(`SELECT version,filename,source_checksum,applied_checksum,catalog_checksum FROM connectlive_install.migrations ORDER BY version`);
  const standard = await query(`SELECT version,name,statements FROM supabase_migrations.schema_migrations ORDER BY version`);
  check('64 reviewed migration provenance records', history.length === plan.length && standard.length === plan.length &&
    plan.every((p,i) => history[i]?.version === p.version && history[i]?.filename === p.file &&
      history[i]?.source_checksum === p.source && history[i]?.applied_checksum === p.checksum &&
      standard[i]?.version === p.version && standard[i]?.name === p.name &&
      JSON.stringify(standard[i]?.statements) === JSON.stringify(p.parts)), { installed: history.length, standard: standard.length, source: plan.length });
  check('catalog fingerprint matches installed reviewed schema', history.at(-1)?.catalog_checksum === await fingerprint(client));
  return { status: gaps.length ? 'GAPS' : 'PASS', readOnly: true, applicationRowsRead: false, checks, gaps, warnings,
    limits: ['Metadata/static literal extraction only; dynamic queries, native JSON mappings, JWT policy execution and device end-to-end flows require separate tests.',
      'Catalog fingerprint proves no drift from reviewed installation, not that every historical policy or source behavior is correct.'] };
}
async function main() {
  if (process.argv.length > 3 || !['--live','--source-only'].includes(process.argv[2] || '--source-only')) throw new Error();
  const source = sourceContracts(), plan = buildPlan();
  if (process.argv[2] !== '--live') {
    console.log(JSON.stringify({ mode: 'source-only', migrations: plan.length, typedTables: source.tables.length,
      expectedTables: TABLES.length, literalColumns: source.columns.size, nativeSelectors: source.nativeSelectors,
      sourceTableReferences: source.from.size, sourceRpcs: source.rpc.size, realtimeSubscriptions: source.realtime.size,
      missingTypedTables: TABLES.filter(t => !source.tables.some(s => s.name === t)), network: false }, null, 2));
    return;
  }
  const { Client } = createRequire(path.join(root, 'lib/db/package.json'))('pg');
  const options = connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL);
  options.application_name = 'connectlive-readonly-alignment';
  const client = new Client(options);
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const result = await verify(client, source, plan);
    await client.query('ROLLBACK');
    console.log(JSON.stringify(result, null, 2));
    if (result.gaps.length) process.exitCode = 2;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}
main().catch(() => {
  console.error('Alignment verification stopped: source/target/TLS validation, connection, or read-only metadata query failed. Details suppressed; no writes were attempted.');
  process.exitCode = 1;
});
