// Actual proxy/helper/route tests with substituted JWT, DB and storage only.
// No network or PostgreSQL; zip encryption implementation is not exercised.
const fs = require("node:fs"), vm = require("node:vm"), ts = require("typescript");
const assert = require("node:assert/strict");
const root = "src/";
function load(file, modules) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(root + file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, Request, Response, URL, URLSearchParams, Blob, Uint8Array, Date,
    crypto: require("node:crypto").webcrypto,
    require(name) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; } });
  return exports;
}
const authorization = load("lib/authorization.server.ts", {});
const server = load("lib/session-files.server.ts", {
  "@supabase/supabase-js": { createClient() { throw new Error("no external clients"); } },
  "@zip.js/zip.js": { configure() {} },
  "./authorization.server": authorization,
});
const helpers = { ...server,
  buildEncryptedZip: async entries => new Blob(entries.map(entry => entry.data)),
  unwrapPassword: async () => "isolated-password-substitute",
};
const proxy = load("lib/session-file-proxy.server.ts", { "./session-files.server": helpers });
const sid = "11111111-1111-4111-8111-111111111111";
const path = `${sid}/22222222-2222-4222-8222-222222222222-file.txt`;
const uploadPath = `${sid}/44444444-4444-4444-8444-444444444444-new.txt`;
const fileId = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const f = { permitted: true, owner: "tech", actor: "tech", superAdmin: false, authenticated: true,
    rpcError: false, reads: [], writes: [], removed: [], secret: true, files: [
      { id: fileId, session_id: sid, name: "file.txt", size_bytes: 3, storage_path: path, deleted_at: null },
    ], blobs: new Map([[path, new Blob(["abc"])]]),
  };
  const admin = {
    auth: { getUser: async token => ({ data: { user: f.authenticated && token === "test-jwt" ? { id: f.actor } : null }, error: null }) },
    rpc: async (name, args) => {
      if (name === "has_role") return { data: f.superAdmin, error: null };
      assert.equal(name, "session_authorized"); assert.equal(args._capability, "files");
      return { data: f.permitted && args._session_id === sid, error: f.rpcError ? {} : null };
    },
    from(table) {
      const filters = [];
      let insertion;
      const rows = () => f.files.filter(row => filters.every(([k,v]) =>
        Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
      const q = {
        select() { return q; }, eq(k,v) { filters.push([k,v]); return q; },
        is(k,v) { filters.push([k,v]); return q; }, in(k,v) { filters.push([k,v]); return q; },
        insert(value) { insertion = value; return q; },
        async single() { f.files.push({ id: fileId, ...insertion }); return { data: { id: fileId }, error: null }; },
        async maybeSingle() {
          if (table === "sessions") return { data: filters.some(([k,v]) => k === "id" && v !== sid) ? null :
            { id: sid, technician_id: f.owner }, error: null };
          if (table === "session_secrets") return { data: f.secret ? {
            wrapped_password: "wrapped", iv: "iv", expires_at: "2099-01-01T00:00:00Z",
          } : null, error: null };
          return { data: rows()[0] ?? null, error: null };
        },
        then(resolve, reject) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); },
      };
      return q;
    },
    storage: { from(bucket) {
      assert.equal(bucket, "session-files");
      return {
        async download(key) {
          f.reads.push(key); if (f.onRead) f.onRead();
          return { data: f.blobs.get(key) ?? null, error: f.blobs.has(key) ? null : {} };
        },
        async upload(key, blob, options) {
          assert.equal(options.upsert, false);
          if (f.blobs.has(key)) return { error: { message: "already exists" } };
          f.writes.push(key); f.blobs.set(key, blob); if (f.onWrite) f.onWrite();
          return { error: null };
        },
        async remove(keys) { f.removed.push(...keys); return { error: null }; },
      };
    } },
  };
  f.admin = admin;
  f.call = async ({ method = "GET", query = `fileId=${fileId}`, body, jwt = "test-jwt", sessionId = sid, headers = {} } = {}) => {
    const route = load("routes/api/public/admin/session.$sessionId.files.bytes.ts", {
      "@tanstack/react-router": { createFileRoute: () => config => config },
      "@/lib/server-supabase": { adminClient: () => admin },
      "@/lib/session-file-proxy.server": proxy,
    });
    return route.Route.server.handlers[method]({
      request: new Request(`https://isolated.invalid/api/public/admin/session/${sessionId}/files/bytes?${query}`, {
        method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...headers },
        ...(method === "PUT" && body !== null ? { body: body ?? "abc" } : {}),
      }), params: { sessionId },
    });
  };
  return f;
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("PASS", name); }
(async () => {
  for (const jwt of ["", "wrong"]) await test(`no byte access with ${jwt ? "invalid" : "missing"} JWT`, async () => {
    const f = fixture(); assert.equal((await f.call({ jwt })).status, 401);
    assert.equal(f.reads.length + f.writes.length, 0);
  });
  await test("unrelated owner denied before storage", async () => {
    const f = fixture(); f.actor = "other";
    assert.equal((await f.call()).status, 403); assert.equal(f.reads.length, 0);
  });
  await test("revoked session denies upload/download even for super-admin", async () => {
    const f = fixture(); f.actor = "other"; f.superAdmin = true; f.permitted = false;
    assert.equal((await f.call()).status, 403);
    assert.equal((await f.call({ method: "PUT", query: `path=${encodeURIComponent(path)}` })).status, 403);
    assert.equal(f.reads.length + f.writes.length, 0);
  });
  await test("wrong session denied before storage", async () => {
    const f = fixture(); assert.equal((await f.call({ sessionId: "other" })).status, 403);
    assert.equal(f.reads.length, 0);
  });
  await test("missing authority migration fails closed", async () => {
    const f = fixture(); f.rpcError = true;
    assert.equal((await f.call()).status, 403); assert.equal(f.reads.length, 0);
  });
  for (const badPath of [`other/123-file.txt`, `${sid}/../secret`, `${sid}/parts/x-file`,
    `${sid}/123-%2e%2e`, `${sid}/123-..\\secret`]) await test(`reject upload path ${badPath}`, async () => {
    const f = fixture();
    assert.equal((await f.call({ method: "PUT", query: `path=${encodeURIComponent(badPath)}` })).status, 400);
    assert.equal(f.writes.length, 0);
  });
  await test("valid download returns only owned manifest bytes, attachment/no-store", async () => {
    const f = fixture(), r = await f.call();
    assert.equal(r.status, 200); assert.equal(await r.text(), "abc");
    assert.match(r.headers.get("content-disposition"), /attachment/);
    assert.match(r.headers.get("cache-control"), /no-store/);
  });
  await test("manifest pointing outside session cannot fetch storage", async () => {
    const f = fixture(); f.files[0].storage_path = "other/123-file.txt";
    assert.equal((await f.call()).status, 400); assert.equal(f.reads.length, 0);
  });
  await test("foreign manifest ID not found", async () => {
    const f = fixture(); f.files[0].session_id = "other";
    assert.equal((await f.call()).status, 404); assert.equal(f.reads.length, 0);
  });
  await test("raw download path and JWT in query rejected", async () => {
    const f = fixture();
    assert.equal((await f.call({ query: `path=${encodeURIComponent(path)}` })).status, 400);
    assert.equal((await f.call({ query: `fileId=${fileId}&token=forbidden` })).status, 400);
    assert.equal(f.reads.length, 0);
  });
  await test("revoke during storage download suppresses response bytes", async () => {
    const f = fixture(); f.onRead = () => { f.permitted = false; };
    const r = await f.call(); assert.equal(r.status, 403);
    assert.doesNotMatch(await r.text(), /abc/);
  });
  await test("valid upload goes through authenticated proxy without overwrite", async () => {
    const f = fixture(), r = await f.call({ method: "PUT", query: `path=${encodeURIComponent(uploadPath)}` });
    assert.equal(r.status, 200); assert.equal(f.writes.length, 1);
    assert.equal((await r.json()).path, uploadPath);
    assert.equal((await f.call({ method: "PUT", query: `path=${encodeURIComponent(uploadPath)}` })).status, 409);
  });
  await test("revoke during upload returns denial and cleans staged object", async () => {
    const f = fixture(); f.onWrite = () => { f.permitted = false; };
    assert.equal((await f.call({ method: "PUT", query: `path=${encodeURIComponent(uploadPath)}` })).status, 403);
    assert.deepEqual(f.removed, [uploadPath]);
  });
  await test("zero-byte files remain supported without a request body", async () => {
    const f = fixture();
    assert.equal((await f.call({ method: "PUT", query: `path=${encodeURIComponent(uploadPath)}`,
      body: null, headers: { "content-length": "0" } })).status, 200);
    assert.equal(f.blobs.get(uploadPath).size, 0);
  });
  await test("per-file and cumulative quotas checked before storage upload", async () => {
    const f = fixture();
    assert.equal((await f.call({ method: "PUT", query: `path=${encodeURIComponent(path)}`,
      headers: { "content-length": String(server.MAX_FILE_BYTES + 1) } })).status, 413);
    f.files[0].size_bytes = server.MAX_SESSION_BYTES;
    assert.equal((await f.call({ method: "PUT", query: `path=${encodeURIComponent(path)}` })).status, 413);
    assert.equal(f.writes.length, 0);
  });
  await test("encrypted package requires password and rechecks authority", async () => {
    const f = fixture(); f.secret = false;
    assert.equal((await f.call({ query: `fileIds=${fileId}` })).status, 409);
    assert.equal(f.reads.length, 0);
    f.secret = true; assert.equal((await f.call({ query: `fileIds=${fileId}` })).status, 200);
    f.onRead = () => { f.permitted = false; };
    assert.equal((await f.call({ query: `fileIds=${fileId}` })).status, 403);
  });
  await test("registration refuses wrong path/size and revoked authority", async () => {
    const f = fixture();
    const input = { sessionId: sid, path, name: "file.txt", size: 3, direction: "from_admin" };
    assert.equal((await proxy.registerUploadedFile(f.admin, "tech", { ...input, path: "other/123-file" })).ok, false);
    assert.equal((await proxy.registerUploadedFile(f.admin, "tech", { ...input, size: 2 })).error, "size_mismatch");
    f.permitted = false;
    assert.equal((await proxy.registerUploadedFile(f.admin, "tech", input)).ok, false);
  });
  await test("proxy URLs contain identifiers only, never bearer tokens", () => {
    const url = new URL(proxy.fileProxyUrl(sid, { fileId }), "https://isolated.invalid");
    assert.equal(url.searchParams.get("fileId"), fileId);
    assert.deepEqual([...url.searchParams.keys()], ["fileId"]);
  });
  await test("browser prepare/download/package functions retain features via JWT proxy URLs", async () => {
    const f = fixture();
    const functions = load("lib/session-files.functions.ts", {
      "@tanstack/react-start": {
        createServerFn() {
          let validate;
          const chain = {
            middleware: () => chain,
            inputValidator(fn) { validate = fn; return chain; },
            handler(fn) { return arg => fn({ ...arg, data: validate(arg.data) }); },
          };
          return chain;
        },
      },
      "@/integrations/supabase/auth-middleware": { requireSupabaseAuth: {} },
      "@/lib/session-files.server": { ...helpers, serviceClient: () => f.admin },
      "@/lib/session-file-proxy.server": proxy,
    });
    const context = { supabase: f.admin, userId: "tech" };
    const prep = await functions.prepareSessionUpload({ data: { sessionId: sid, name: "test.txt", size: 3 }, context });
    assert.equal(prep.ok, true); assert.equal(prep.token, undefined);
    assert.match(prep.url, /\/files\/bytes\?path=/);
    const download = await functions.getSessionFileUrl({ data: { sessionId: sid, fileId }, context });
    assert.equal(download.ok, true); assert.match(download.url, /\/files\/bytes\?fileId=/);
    const zip = await functions.packageSessionFiles({ data: { sessionId: sid, fileIds: [fileId] }, context });
    assert.equal(zip.ok, true); assert.match(zip.url, /\/files\/bytes\?fileIds=/);
    assert.equal(f.reads.length, 0); // bytes deferred to the authenticated proxy
  });
  await test("native prepare uses compatibility field but issues no bearer token", async () => {
    const f = fixture();
    const route = load("routes/api/public/admin/session.$sessionId.files.ts", {
      "@tanstack/react-router": { createFileRoute: () => config => config },
      "@/lib/authorization.server": authorization,
      "@/lib/server-supabase": { adminClient: () => f.admin },
      "@/lib/session-files.server": helpers,
      "@/lib/session-file-proxy.server": proxy,
    });
    const r = await route.Route.server.handlers.POST({
      request: new Request("https://isolated.invalid/files", { method: "POST",
        headers: { authorization: "Bearer test-jwt", "x-action": "prepare" },
        body: JSON.stringify({ name: "test.txt", size: 3 }),
      }), params: { sessionId: sid },
    });
    assert.equal(r.status, 200);
    const prep = await r.json();
    assert.equal(prep.token, undefined); assert.equal(prep.signedUrl, prep.url);
    assert.match(prep.url, /\/files\/bytes\?path=/);
    assert.equal(f.reads.length + f.writes.length, 0);
  });
  console.log(`${passed} file proxy checks passed (JWT/DB/storage/zip substitutes; no external DB).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
