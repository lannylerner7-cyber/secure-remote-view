const assert = require("node:assert/strict");
const { checkConfig } = require("./check-connectlive-config.cjs");
const jwt = role => `test.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.synthetic`;
const good = {
  SUPABASE_URL: "https://esjlqcfcwewymmeghbvj.supabase.co",
  VITE_SUPABASE_URL: "https://esjlqcfcwewymmeghbvj.supabase.co/",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
  SUPABASE_SERVICE_ROLE_KEY: jwt("service_role"),
  SESSION_SECRET_KEY: "synthetic-test-material-not-a-real-secret",
};
assert(checkConfig(good).every(r => r.ok));
for (const name of Object.keys(good)) {
  assert(checkConfig({ ...good, [name]: "" }).some(r => !r.ok), name);
}
for (const value of [jwt("service_role"), "sb_secret_synthetic"]) {
  assert(checkConfig({ ...good, VITE_SUPABASE_PUBLISHABLE_KEY: value }).some(r => !r.ok));
}
assert(checkConfig({ ...good, VITE_CUSTOM_PASSWORD: "synthetic" }).some(r => !r.ok));
assert(checkConfig({ ...good, SUPABASE_URL: good.SUPABASE_URL + "/wrong" }).some(r => !r.ok));
assert(!JSON.stringify(checkConfig(good)).includes("synthetic"));
console.log("Configuration validation: 13 assertions passed.");
