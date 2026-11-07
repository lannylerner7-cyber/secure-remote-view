// Legacy route fixtures keep their isolated device contexts, but use the real
// failure response mapping. No environment, network or database is available.
const crypto = require("node:crypto");
const { load } = require("./agent-http.cjs");
const auth = load("lib/agent-auth.server.ts", {
  crypto,
  "./server-supabase": { adminClient() { throw Error("Unexpected database access"); } },
});

function stubDeviceAuth(context) {
  return {
    ...auth,
    async verifyDevice() {
      const value = await context();
      return value ? { kind: "verified", ...value } : { kind: "unauthorized" };
    },
  };
}
module.exports = { stubDeviceAuth };
