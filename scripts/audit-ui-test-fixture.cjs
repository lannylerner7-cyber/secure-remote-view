// Disposable, owner-scoped audit fixtures. No devices, licenses or orders.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const app = fs.existsSync(path.join(root, "package.json")) ? path.join(root, ".") : root;
const { createClient } = require("node:module").createRequire(path.join(app, "package.json"))("@supabase/supabase-js");
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
async function checked(result) { if (result.error) throw new Error(result.error.message); return result.data; }
async function create() {
  const marker = crypto.randomBytes(8).toString("hex");
  const file = path.join(root, `generated-artifacts/testing/audit-${marker}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fixture = { marker, eventSearch: `audit-fixture.${marker}`, users: [], auditIds: [], expectedCount: 61 };
  const save = () => fs.writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
  save();
  try {
    for (const suffix of ["owner", "outsider"]) {
      const email = `audit-fixture-${marker}-${suffix}@example.invalid`;
      const password = crypto.randomBytes(24).toString("base64url") + "aA1!";
      const data = await checked(await db.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { audit_fixture: marker },
      }));
      fixture.users.push({ id: data.user.id, email, password }); save();
      await checked(await db.from("user_roles").delete().eq("user_id", data.user.id));
      await checked(await db.from("user_roles").insert({ user_id: data.user.id, role: "technician" }));
    }
    const time = new Date(Date.now() - 5000).toISOString();
    const rows = Array.from({ length: 62 }, (_, i) => ({
      id: crypto.randomUUID(), actor: fixture.users[i === 61 ? 1 : 0].id,
      created_at: time, event: i === 60 ? `=1+1 ${fixture.eventSearch}` : `${fixture.eventSearch}.${i === 61 ? "outside-owner" : "session.opened"}`,
      detail: {
        fixture: marker, sequence: i, note: 'Lagos – café, "quoted"\nSecond line',
        password: "synthetic-redaction-marker", pairing_code: "not-a-real-code",
      },
    }));
    fixture.auditIds = rows.map((row) => row.id); save();
    await checked(await db.from("audit_logs").insert(rows));
    console.log(JSON.stringify({ file, created: true, ownerRows: 61, outsideOwnerRows: 1 }));
  } catch (error) {
    await cleanup(file).catch(() => {});
    throw error;
  }
}
async function cleanup(file) {
  if (!/\/generated-artifacts\/testing\/audit-[a-f0-9]{16}\.json$/.test(file ?? "")) {
    throw new Error("Unexpected audit fixture path");
  }
  const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const user of fixture.users) {
    const data = await checked(await db.auth.admin.getUserById(user.id));
    if (data.user.email !== user.email || data.user.user_metadata.audit_fixture !== fixture.marker ||
        !user.email.startsWith(`audit-fixture-${fixture.marker}-`)) throw new Error("Fixture identity guard failed");
  }
  const ids = fixture.users.map((u) => u.id);
  if (ids.length) {
    await checked(await db.from("audit_logs").delete().in("actor", ids));
    await checked(await db.from("notifications").delete().in("recipient_id", ids));
    await checked(await db.from("login_attempts").delete().in("identifier",
      fixture.users.flatMap((u) => [u.email.toLowerCase(), `tech-${u.id}@connectlive.internal`])));
    for (const user of fixture.users) await checked(await db.auth.admin.deleteUser(user.id));
  }
  fs.unlinkSync(file);
  console.log(JSON.stringify({ cleaned: true, users: ids.length }));
}
(process.argv[2] === "--create" ? create() :
  process.argv[2] === "--cleanup" ? cleanup(process.argv[3]) :
  Promise.reject(new Error("Use --create or --cleanup <private-fixture-file>")))
  .catch(() => { console.error("Audit fixture operation failed; no credentials were printed."); process.exitCode = 1; });
