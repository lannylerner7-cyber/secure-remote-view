const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function fixture(handler) {
  const errors = [], exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/server.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, Response, Request, Set,
    console: { error: error => errors.push(error) },
    require(name) {
      if (name === "@tanstack/react-start/server-entry") return { default: { fetch: handler } };
      if (name === "./lib/error-capture") return { consumeLastCapturedError: () => undefined };
      if (name === "./lib/error-page") return { renderErrorPage: () => "<h1>Server error</h1>" };
      if (name === "./lib/response-cache-policy") return { applyResponseCachePolicy: (_request, response) => response };
      throw Error(`Unexpected import ${name}`);
    },
  });
  const controller = new AbortController();
  const request = new Request("https://example.test/console", { signal: controller.signal });
  return { request, controller, errors, fetch: () => exports.default.fetch(request, {}, {}) };
}

test("an already disconnected request never starts application work", async () => {
  let calls = 0;
  const f = fixture(() => { calls++; return new Response("unexpected"); });
  f.controller.abort();
  const response = await f.fetch();
  assert.equal(response.status, 499);
  assert.equal(calls, 0);
  assert.equal(f.errors.length, 0);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

for (const wrapped of [false, true]) {
  test(`a ${wrapped ? "wrapped" : "direct"} socket AbortError is not a catastrophic page error`, async () => {
    const f = fixture(() => {
      f.controller.abort();
      const error = new DOMException("This operation was aborted", "AbortError");
      throw wrapped ? new Error("HTTPError", { cause: error }) : error;
    });
    assert.equal((await f.fetch()).status, 499);
    assert.equal(f.errors.length, 0);
  });
}

test("h3's swallowed response is cancellation only for this aborted request", async () => {
  const body = JSON.stringify({ status: 500, unhandled: true, message: "HTTPError" });
  const f = fixture(() => {
    f.controller.abort();
    return new Response(body, { status: 500, headers: { "content-type": "application/json" } });
  });
  assert.equal((await f.fetch()).status, 499);
  assert.equal(f.errors.length, 0);
  const healthy = fixture(() => new Response(body, {
    status: 500, headers: { "content-type": "application/json" },
  }));
  assert.equal((await healthy.fetch()).status, 500);
  assert.equal(healthy.errors.length, 1, "a live request's real server error is still logged");
});

test("upstream AbortErrors do not masquerade as client disconnects", async () => {
  const f = fixture(() => { throw new DOMException("Upstream aborted", "AbortError"); });
  assert.equal((await f.fetch()).status, 500);
  assert.equal(f.errors.length, 1);
});

test("Node's aborted incoming socket is cancellation only for an aborted request", async () => {
  const error = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  const f = fixture(() => { f.controller.abort(); throw new Error("HTTPError", { cause: error }); });
  assert.equal((await f.fetch()).status, 499);
  assert.equal(f.errors.length, 0);
  const live = fixture(() => { throw error; });
  assert.equal((await live.fetch()).status, 500);
  assert.equal(live.errors.length, 1);
});

test("unrelated connection-reset errors remain visible", async () => {
  const f = fixture(() => {
    f.controller.abort();
    throw Object.assign(new Error("upstream socket reset"), { code: "ECONNRESET" });
  });
  assert.equal((await f.fetch()).status, 500);
  assert.equal(f.errors.length, 1);
});

test("an unrelated bug remains an error even if the client also disconnects", async () => {
  const f = fixture(() => { f.controller.abort(); throw new TypeError("Application bug"); });
  assert.equal((await f.fetch()).status, 500);
  assert.equal(f.errors.length, 1);
});

test("normal JSON and streaming responses remain unchanged", async () => {
  for (const response of [
    Response.json({ ok: true }),
    new Response("event: ready\n\n", { headers: { "content-type": "text/event-stream" } }),
    Response.json({ error: "real_failure" }, { status: 503 }),
  ]) {
    const f = fixture(() => response);
    assert.equal(await f.fetch(), response);
    assert.equal(f.errors.length, 0);
  }
});
