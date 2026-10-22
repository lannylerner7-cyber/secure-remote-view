// Isolated transport tests. Only synthetic loopback SMTP peers and dummy values;
// never boot the application, read real environment secrets, or contact a DB.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const net = require("node:net");
const ts = require("typescript");

const compiled = ts.transpileModule(
  fs.readFileSync("src/lib/smtp.server.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true },
);
assert.equal(compiled.diagnostics.length, 0, "SMTP source must transpile");

function load(env = {}, db = { data: null, error: null }, cloudflare = null, netOverride = null) {
  const exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports, process: { env }, TextEncoder, TextDecoder, Buffer, btoa,
    AbortController, URL, setTimeout, clearTimeout,
    require(name) {
      if (name === "cloudflare:sockets") {
        if (cloudflare) return cloudflare;
        throw new Error("not a Worker");
      }
      if (name === "node:net") return netOverride ?? net;
      if (name === "node:tls") return require(name);
      if (name === "@/integrations/supabase/client.server") {
        const query = {
          select() { return query; }, eq() { return query; },
          async maybeSingle() {
            if (db instanceof Error) throw db;
            return db;
          },
        };
        return { supabaseAdmin: { from() { return query; } } };
      }
      throw new Error("Unexpected dependency");
    },
  });
  return exports;
}

const settings = {
  host: "127.0.0.1", port: 25, username: "", password: "",
  from_name: "Synthetic Sender", from_address: "sender@example.invalid",
  reply_to: "", encryption: "none", enabled: true, updated_at: "",
};
const message = { to: "recipient@example.invalid", subject: "Synthetic test", text: "test", html: "<p>test</p>" };
const builtin = { SMTP_HOST: "127.0.0.1", SMTP_FROM_ADDRESS: "builtin@example.invalid" };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function peer(mode, test) {
  const sockets = new Set();
  const commands = [];
  let connections = 0;
  let closed = 0;
  let accepted = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { closed++; sockets.delete(socket); });
    if (mode === "silent" || mode === "tls-stall") { socket.resume(); return; }
    if (mode === "overflow") {
      socket.write("x".repeat(70 * 1024));
      return;
    }
    socket.write("220 synthetic SMTP\r\n");
    let buffer = "";
    let data = false;
    let upgrading = false;
    socket.on("data", (chunk) => {
      if (upgrading) return; // Ignore ClientHello; intentionally never handshake.
      buffer += chunk.toString();
      if (data) {
        if (buffer.includes("\r\n.\r\n")) {
          data = false;
          buffer = "";
          accepted++;
          socket.write("250 accepted\r\n");
        }
        return;
      }
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        if (line.startsWith("EHLO")) {
          if (mode === "ehlo-stall") continue;
          if (mode === "reject") socket.write("550 private recipient@example.invalid DUMMY-KEY\r\n");
          else if (mode === "starttls-stall") socket.write("250-localhost\r\n250 STARTTLS\r\n");
          else socket.write("250 localhost\r\n");
        } else if (line === "STARTTLS") {
          socket.write("220 upgrade\r\n");
          upgrading = true;
          return;
        } else if (line.startsWith("MAIL") || line.startsWith("RCPT")) socket.write("250 OK\r\n");
        else if (line === "DATA") { data = true; socket.write("354 send\r\n"); }
        // QUIT intentionally gets no reply.
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await test({
      port: server.address().port, commands,
      stats: () => ({ connections, closed, accepted }),
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const api = load();
  for (const [mode, encryption] of [
    ["silent", "none"], ["ehlo-stall", "none"],
    ["tls-stall", "ssl"], ["starttls-stall", "starttls"],
  ]) {
    await peer(mode, async ({ port, commands, stats }) => {
      await assert.rejects(api.sendMail({ ...settings, port, encryption }, message, 150), /timed out/);
      const count = commands.length;
      await delay(80);
      assert.equal(stats().closed, stats().connections, `${mode}: timeout closes the socket`);
      assert.equal(commands.length, count, `${mode}: no commands after timeout`);
      assert.equal(commands.some((line) => /^(?:AUTH|MAIL|RCPT|DATA)/.test(line)), false);
    });
  }
  console.log("PASS: greeting, EHLO, implicit TLS and STARTTLS deadlines close sockets; no late sends");

  await peer("accept", async ({ port, stats }) => {
    let lookupDone;
    let pendingSocket;
    const dnsApi = load({}, undefined, null, {
      ...net,
      connect(options, callback) {
        pendingSocket = net.connect({
          ...options,
          lookup(_host, _options, done) { lookupDone = done; },
        }, callback);
        return pendingSocket;
      },
    });
    await assert.rejects(dnsApi.sendMail({ ...settings, host: "synthetic.invalid", port }, message, 100), /timed out/);
    assert.equal(pendingSocket.destroyed, true);
    // Release our synthetic DNS result after timeout. It must never connect.
    lookupDone(null, [{ address: "127.0.0.1", family: 4 }]);
    await delay(50);
    assert.equal(stats().connections, 0);
  });
  console.log("PASS: pending synthetic DNS lookup socket destroyed; late lookup cannot connect");

  // Simulate only the Cloudflare stream API: verify STARTTLS unlocks streams
  // without calling cancel()/close() on them (which would kill the connection).
  let upgrades = 0;
  let cancels = 0;
  let writerCloses = 0;
  let socketCloses = 0;
  function cfSocket(initial = false, silent = false) {
    let controller;
    const readable = new ReadableStream({
      start(c) { controller = c; if (initial && !silent) c.enqueue(new TextEncoder().encode("220 synthetic\r\n")); },
      cancel() { cancels++; },
    });
    const reply = (text) => controller.enqueue(new TextEncoder().encode(text));
    const writable = new WritableStream({
      write(bytes) {
        const line = new TextDecoder().decode(bytes);
        if (line.startsWith("EHLO")) reply(initial ? "250-localhost\r\n250 STARTTLS\r\n" : "250 localhost\r\n");
        else if (line === "STARTTLS\r\n") reply("220 upgrade\r\n");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) reply("250 OK\r\n");
        else if (line === "DATA\r\n") reply("354 send\r\n");
        else if (line.endsWith("\r\n.\r\n")) reply("250 accepted\r\n");
      },
      close() { writerCloses++; },
    });
    return {
      readable, writable,
      startTls() {
        assert.equal(readable.locked, false);
        assert.equal(writable.locked, false);
        upgrades++;
        return cfSocket();
      },
      async close() { socketCloses++; controller.close(); },
    };
  }
  const cfApi = load({}, undefined, { connect: () => cfSocket(true) });
  await cfApi.sendMail({ ...settings, encryption: "starttls" }, message, 300);
  assert.equal(upgrades, 1);
  assert.equal(cancels, 0);
  assert.equal(writerCloses, 0);
  assert.equal(socketCloses, 1);
  const cfSilent = load({}, undefined, { connect: () => cfSocket(true, true) });
  await assert.rejects(cfSilent.sendMail(settings, message, 50), /timed out/);
  assert.ok(socketCloses >= 2);
  console.log("PASS: Cloudflare STARTTLS releases locks without stream cancellation; timeout closes socket");

  await peer("accept", async ({ port, stats }) => {
    await api.sendMail({ ...settings, port }, { ...message, replyTo: "<support@example.invalid>" }, 300);
    await api.sendMail({ ...settings, port }, { ...message, replyTo: "Synthetic, Contact <contact@example.invalid>" }, 300);
    await delay(50);
    assert.equal(stats().accepted, 2);
    assert.equal(stats().closed, 2);
  });
  console.log("PASS: accepted DATA succeeds despite a peer that never answers QUIT");

  await peer("reject", async ({ port }) => {
    let error;
    try { await api.sendMail({ ...settings, port }, message, 300); } catch (e) { error = e; }
    assert.equal(api.mailErrorReason(error), "SMTP server rejected request (550)");
    assert.doesNotMatch(String(error), /recipient@|DUMMY-KEY/);
    assert.equal(api.mailErrorReason(new Error("private DUMMY-KEY")), "SMTP delivery failed");
  });
  await peer("overflow", async ({ port }) => {
    await assert.rejects(api.sendMail({ ...settings, port }, message, 300), /size limit/);
  });
  console.log("PASS: provider content sanitized and reply size bounded");

  await peer("accept", async ({ port, stats }) => {
    for (const patch of [
      { to: "x@example.invalid>\r\nRCPT TO:<other@example.invalid" },
      { subject: "subject\r\nBcc: other@example.invalid" },
      { replyTo: "x@example.invalid\nBcc: other@example.invalid" },
      { headers: { "X-Test\r\nBcc": "bad" } },
      { headers: { "List-Unsubscribe": "ok\r\nBcc: bad" } },
      { headers: { From: "forged@example.invalid" } },
    ]) await assert.rejects(api.sendMail({ ...settings, port }, { ...message, ...patch }), /Invalid SMTP/);
    for (const patch of [
      { host: "127.0.0.1\r\nQUIT" }, { port: 0 }, { port: 2.5 }, { port: 65536 },
      { encryption: "typo" }, { from_address: "bad@example.invalid>\r\nQUIT" },
      { from_name: "sender\nBcc: bad" }, { username: "dummy", password: "dummy" },
    ]) await assert.rejects(api.sendMail({ ...settings, port, ...patch }, message), /Invalid SMTP|requires TLS/);
    assert.equal(stats().connections, 0);
  });
  console.log("PASS: address/header injection and invalid/unencrypted authentication rejected before connection");

  assert.equal(load().envSmtpSettings(), null);
  assert.equal(load(builtin).envSmtpSettings().port, 587);
  assert.equal(load({ ...builtin, SMTP_PORT: "465" }).envSmtpSettings().encryption, "ssl");
  assert.equal(load({ ...builtin, SMTP_PORT: "25" }).envSmtpSettings().encryption, "none");
  for (const value of ["", "0", "65536", "2.5", "abc", "-1"]) {
    assert.throws(() => load({ ...builtin, SMTP_PORT: value }).envSmtpSettings(), /Invalid SMTP port/);
  }
  for (const value of ["", "TLS", "invalid"]) {
    assert.throws(() => load({ ...builtin, SMTP_ENCRYPTION: value }).envSmtpSettings(), /Invalid SMTP encryption/);
  }
  assert.throws(() => load({ SMTP_HOST: "127.0.0.1" }).envSmtpSettings(), /Incomplete/);
  assert.equal((await load(builtin, { data: settings }).resolveSmtpSource()).source, "custom");
  assert.equal((await load(builtin, { data: { ...settings, enabled: false } }).resolveSmtpSource()).source, "builtin");
  assert.equal((await load(builtin).resolveSmtpSource()).source, "builtin");
  assert.equal((await load().resolveSmtpSource()).source, "none");
  // Enabled custom input must fail, never select a different configured sender.
  await assert.rejects(load(builtin, { data: { ...settings, host: "" } }).resolveSmtpSource(), /Invalid SMTP/);
  for (const db of [{ error: { message: "private DUMMY-KEY" } }, new Error("private DUMMY-KEY")]) {
    await assert.rejects(load(builtin, db).resolveSmtpSource(), /^MailTransportError: SMTP settings could not be loaded$/);
  }
  console.log("PASS: environment inference/explicit errors; enabled custom precedence; DB failure never falls back");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
