#!/usr/bin/env node
// Names and outcomes only: never emit credential values or raw provider errors.
const expectedOrigin = "https://esjlqcfcwewymmeghbvj.supabase.co";
function checkConfig(env) {
  const results = [];
  const add = (name, ok, issue) => results.push({ name, ok, ...(ok ? {} : { issue }) });
  for (const name of ["SUPABASE_URL", "VITE_SUPABASE_URL"]) {
    let matches = false;
    try {
      const url = new URL(env[name]);
      matches = url.origin === expectedOrigin && !url.username && !url.password &&
        !url.search && !url.hash && url.pathname === "/";
    } catch {}
    add(name, matches, "missing or not the selected project URL");
  }
  function keyRole(value) {
    if (!value) return null;
    if (value.startsWith("sb_publishable_")) return "anon";
    if (value.startsWith("sb_secret_")) return "secret";
    try { return JSON.parse(Buffer.from(value.split(".")[1], "base64url")).role; }
    catch { return null; }
  }
  for (const name of ["SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY"]) {
    add(name, keyRole(env[name]) === "anon", "missing or not a public key");
  }
  add("PUBLIC_KEYS_MATCH", !!env.SUPABASE_PUBLISHABLE_KEY &&
    env.SUPABASE_PUBLISHABLE_KEY === env.VITE_SUPABASE_PUBLISHABLE_KEY, "public keys differ or are absent");
  // Legacy consumers also use this credential for HMAC. Review opaque keys
  // across every consumer before accepting them as a drop-in replacement.
  add("SUPABASE_SERVICE_ROLE_KEY", keyRole(env.SUPABASE_SERVICE_ROLE_KEY) === "service_role",
    "missing or not a legacy service-role JWT");
  add("SESSION_SECRET_KEY", (env.SESSION_SECRET_KEY || "").length >= 32,
    "missing or shorter than 32 characters; SESSION_SECRET is not a substitute");
  for (const name of Object.keys(env).filter(name => name.startsWith("VITE_"))) {
    if (/SECRET|PASSWORD|PRIVATE|SERVICE_ROLE|TOKEN|DATABASE_URL/i.test(name) ||
      ["service_role", "secret"].includes(keyRole(env[name]))) {
      add(name, false, "privileged value or secret-like name must not be browser-visible");
    }
  }
  return results;
}
module.exports = { checkConfig };
if (require.main === module) {
  const results = checkConfig(process.env);
  for (const item of results) console.log(`${item.ok ? "PASS" : "BLOCKED"} ${item.name}${item.issue ? `: ${item.issue}` : ""}`);
  console.log("Local configuration checks only; this does not verify credentials with Supabase.");
  process.exitCode = results.every(item => item.ok) ? 0 : 1;
}
