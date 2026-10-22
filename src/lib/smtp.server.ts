/**
 * Minimal, dependency-free SMTP client + settings loader.
 *
 * Server-only. Runs on both the Cloudflare Worker runtime (via `cloudflare:sockets`)
 * and the local Node dev server (via `node:net` / `node:tls`), so no `nodemailer`
 * (Node-only, non-bundleable on workerd) is required.
 */

export type SmtpEncryption = "none" | "starttls" | "ssl";

export type SmtpSettings = {
  host: string;
  port: number;
  username: string;
  password: string;
  from_name: string;
  from_address: string;
  reply_to: string;
  encryption: SmtpEncryption;
  enabled: boolean;
  updated_at: string;
};

/* ------------------------------------------------------------------ wires */

interface Wire {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  startTls(servername: string): Promise<void>;
  close(): Promise<void>;
}

class MailTransportError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MailTransportError";
  }
}

/** Safe for UI/logs: never returns provider replies, addresses or credentials. */
export function mailErrorReason(error: unknown): string {
  return error instanceof MailTransportError ? error.reason : "SMTP delivery failed";
}

function fail(reason: string): never {
  throw new MailTransportError(reason);
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) fail("SMTP delivery timed out");
}

const MAX_REPLY_BYTES = 64 * 1024;

async function loadCloudflareSockets(): Promise<{
  connect: (
    addr: { hostname: string; port: number },
    opts?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean },
  ) => CfSocket;
} | null> {
  try {
    // Built from parts so bundlers don't try to resolve it on Node.
    const specifier = "cloudflare" + ":sockets";
    return (await import(/* @vite-ignore */ specifier)) as never;
  } catch {
    return null;
  }
}

type CfSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls: () => CfSocket;
  close: () => Promise<void>;
};

function cfWire(initial: CfSocket, signal: AbortSignal): Wire {
  let socket = initial;
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const abort = () => { void socket.close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    async read() {
      checkAbort(signal);
      const { value, done } = await reader.read();
      checkAbort(signal);
      return done ? null : (value ?? null);
    },
    async write(data) {
      checkAbort(signal);
      await writer.write(data);
      checkAbort(signal);
    },
    async startTls() {
      checkAbort(signal);
      // Cloudflare requires unlocked streams, not cancelled/closed streams.
      // No read/write is pending here: the STARTTLS reply was fully consumed.
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      checkAbort(signal);
    },
    async close() {
      signal.removeEventListener("abort", abort);
      try {
        await socket.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function nodeWire(host: string, port: number, tlsFromStart: boolean, signal: AbortSignal): Promise<Wire> {
  const net = await import("node:net");
  const tls = await import("node:tls");
  checkAbort(signal);

  type Sock = import("node:net").Socket;
  let socket: Sock | undefined;
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let waiter: ((v: Uint8Array | null) => void) | null = null;
  let ended = false;
  let overflow = false;
  const abort = () => { socket?.destroy(); };
  signal.addEventListener("abort", abort, { once: true });

  const attach = (s: Sock) => {
    s.on("data", (chunk: Buffer) => {
      const u8 = new Uint8Array(chunk);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(u8);
      } else {
        queuedBytes += u8.byteLength;
        if (queuedBytes > MAX_REPLY_BYTES) {
          overflow = true;
          s.destroy();
        } else queue.push(u8);
      }
    });
    const finish = () => {
      ended = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    };
    s.on("end", finish);
    s.on("close", finish);
    s.on("error", finish);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new MailTransportError("SMTP delivery timed out"));
      const connected = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      // Store the socket before connection/DNS/TLS completes so abort destroys it.
      socket = tlsFromStart
        ? tls.connect({ host, port, servername: host }, connected)
        : net.connect({ host, port }, connected);
      attach(socket);
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("error", (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      if (signal.aborted) { abort(); onAbort(); }
    });
    checkAbort(signal);
  } catch (error) {
    signal.removeEventListener("abort", abort);
    socket?.destroy();
    throw error;
  }

  return {
    read() {
      checkAbort(signal);
      if (overflow) fail("SMTP reply exceeded size limit");
      const next = queue.shift();
      if (next) {
        queuedBytes -= next.byteLength;
        return Promise.resolve(next);
      }
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    write(data) {
      checkAbort(signal);
      return new Promise((resolve, reject) => {
        socket!.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
      });
    },
    async startTls(servername) {
      checkAbort(signal);
      const plain = socket!;
      plain.removeAllListeners("data");
      plain.removeAllListeners("end");
      plain.removeAllListeners("close");
      queue.length = 0;
      queuedBytes = 0;
      ended = false;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new MailTransportError("SMTP delivery timed out"));
        socket = tls.connect({ socket: plain, servername }, () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
        attach(socket);
        signal.addEventListener("abort", onAbort, { once: true });
        socket.once("error", (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        });
        if (signal.aborted) { abort(); onAbort(); }
      });
      checkAbort(signal);
    },
    async close() {
      signal.removeEventListener("abort", abort);
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

/* ----------------------------------------------------------- SMTP session */

const enc = new TextEncoder();
const dec = new TextDecoder();

class SmtpSession {
  private buffer = "";
  constructor(private wire: Wire) {}

  private async readLineBlock(): Promise<string> {
    // Reads until a complete SMTP reply (last line has a space after the code).
    for (;;) {
      const lines = this.buffer.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        if (/^\d{3} /.test(line)) {
          const consumed = lines.slice(0, i + 1).join("\r\n") + "\r\n";
          const block = consumed;
          this.buffer = this.buffer.slice(consumed.length);
          return block.trimEnd();
        }
      }
      const chunk = await this.wire.read();
      if (chunk === null) fail("SMTP connection closed unexpectedly");
      if (this.buffer.length + chunk.byteLength > MAX_REPLY_BYTES) fail("SMTP reply exceeded size limit");
      this.buffer += dec.decode(chunk);
    }
  }

  async expect(codes: number[]): Promise<string> {
    const block = await this.readLineBlock();
    const code = Number(block.slice(0, 3));
    if (!codes.includes(code)) fail(`SMTP server rejected request (${code})`);
    return block;
  }

  async send(line: string, codes: number[]): Promise<string> {
    await this.wire.write(enc.encode(line + "\r\n"));
    return this.expect(codes);
  }

  async sendRaw(payload: string): Promise<void> {
    await this.wire.write(enc.encode(payload));
  }
}

function b64(input: string): string {
  const bytes = enc.encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64Lines(input: string): string {
  const raw = b64(input);
  return (raw.match(/.{1,76}/g) ?? []).join("\r\n");
}

function headerEncode(value: string): string {
  // RFC 2047 for non-ASCII subjects / display names.
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Optional per-message Reply-To, e.g. `Jane <jane@example.com>`. */
  replyTo?: string;
  /** Extra RFC 5322 headers (e.g. List-Unsubscribe). Values are single-line. */
  headers?: Record<string, string>;
};

function singleLine(value: unknown, field: string, max = 998): asserts value is string {
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    fail(`Invalid SMTP ${field}`);
  }
}

function address(value: unknown, field: string): asserts value is string {
  singleLine(value, field, 254);
  // Deliberately accept only a single bare mailbox, never SMTP paths or lists.
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) ||
      value.includes("..") || value.startsWith(".") || value.includes(".@") ||
      value.split("@")[0]!.length > 64 ||
      !value.split("@")[1]!.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    fail(`Invalid SMTP ${field}`);
  }
}

/** Throws a sanitized error; does not normalize or silently repair invalid input. */
export function validateSmtpSettings(settings: SmtpSettings): void {
  if (!settings || typeof settings !== "object") fail("Invalid SMTP settings");
  singleLine(settings.host, "host", 253);
  if (settings.host.includes(":")) {
    try {
      // URL's IPv6 parser validates syntax without DNS/network activity.
      if (!/^[A-Fa-f0-9:.]+$/.test(settings.host)) fail("Invalid SMTP host");
      new URL(`http://[${settings.host}]/`);
    } catch { fail("Invalid SMTP host"); }
  } else if (!settings.host.split(".").every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    fail("Invalid SMTP host");
  }
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) fail("Invalid SMTP port");
  if (!["none", "starttls", "ssl"].includes(settings.encryption)) fail("Invalid SMTP encryption");
  if (typeof settings.enabled !== "boolean") fail("Invalid SMTP enabled flag");
  singleLine(settings.username, "username", 1024);
  singleLine(settings.password, "password", 4096);
  if (settings.encryption === "none" && (settings.username || settings.password)) {
    fail("SMTP authentication requires TLS");
  }
  if (settings.password && !settings.username) fail("SMTP password requires username");
  singleLine(settings.from_name, "sender name", 200);
  address(settings.from_address, "sender address");
  singleLine(settings.reply_to, "reply address", 254);
  if (settings.reply_to) address(settings.reply_to, "reply address");
}

function validateMessage(msg: MailMessage): void {
  if (!msg || typeof msg !== "object") fail("Invalid SMTP message");
  address(msg.to, "recipient address");
  singleLine(msg.subject, "subject");
  if (typeof msg.text !== "string" || typeof msg.html !== "string") fail("Invalid SMTP message body");
  if (msg.replyTo !== undefined) {
    formatReplyTo(msg.replyTo);
  }
  if (msg.headers !== undefined && (!msg.headers || typeof msg.headers !== "object" || Array.isArray(msg.headers))) {
    fail("Invalid SMTP headers");
  }
  for (const [name, value] of Object.entries(msg.headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,78}$/.test(name) ||
        /^(?:from|to|cc|bcc|reply-to|subject|date|message-id|mime-version|content-.*|received|return-path)$/i.test(name)) {
      fail("Invalid SMTP header name");
    }
    singleLine(value, "header value");
  }
}

function formatReplyTo(value: string): string {
  singleLine(value, "reply address");
  const display = /^([^<>]*)<([^<>]+)>$/.exec(value);
  if (!display) {
    address(value, "reply address");
    return `<${value}>`;
  }
  const name = display[1]!.trim();
  address(display[2], "reply address");
  singleLine(name, "reply name", 200);
  // Encode display text, so commas/quotes in contact names cannot create lists.
  return `${name ? `=?UTF-8?B?${b64(name)}?= ` : ""}<${display[2]}>`;
}

/** Default hard cap on a single SMTP conversation, so callers can never hang. */
const SMTP_TIMEOUT_MS = 12_000;

/**
 * Send one message through the configured SMTP server. Throws on SMTP failure.
 * Bounded by `timeoutMs` — an unreachable or silent server rejects instead of
 * hanging the request that triggered the send.
 */
export async function sendMail(
  settings: SmtpSettings,
  msg: MailMessage,
  timeoutMs: number = SMTP_TIMEOUT_MS,
): Promise<void> {
  validateSmtpSettings(settings);
  validateMessage(msg);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) fail("Invalid SMTP timeout");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendMailInner(settings, msg, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MailTransportError("SMTP delivery timed out"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) fail("SMTP delivery timed out");
    if (error instanceof MailTransportError) throw error;
    fail("SMTP connection or delivery failed");
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function sendMailInner(settings: SmtpSettings, msg: MailMessage, signal: AbortSignal): Promise<void> {
  const host = settings.host;
  const port = settings.port;
  const implicitTls = settings.encryption === "ssl";

  const cf = await loadCloudflareSockets();
  checkAbort(signal);
  let wire: Wire;
  if (cf) {
    wire = cfWire(
      cf.connect(
        { hostname: host, port },
        { secureTransport: implicitTls ? "on" : settings.encryption === "starttls" ? "starttls" : "off", allowHalfOpen: false },
      ),
      signal,
    );
  } else {
    wire = await nodeWire(host, port, implicitTls, signal);
  }

  const s = new SmtpSession(wire);
  try {
    await s.expect([220]);
    const ehloName = settings.from_address.split("@")[1] || "connectliveagent.com";
    let greeting = await s.send(`EHLO ${ehloName}`, [250]);

    if (settings.encryption === "starttls") {
      if (!/^250[ -]STARTTLS(?:\s|$)/im.test(greeting)) fail("SMTP server does not advertise STARTTLS");
      await s.send("STARTTLS", [220]);
      await wire.startTls(host);
      greeting = await s.send(`EHLO ${ehloName}`, [250]);
    }

    if (settings.username) {
      if (/AUTH[^\r\n]*PLAIN/i.test(greeting)) {
        await s.send(`AUTH PLAIN ${b64(`\0${settings.username}\0${settings.password}`)}`, [235]);
      } else {
        await s.send("AUTH LOGIN", [334]);
        await s.send(b64(settings.username), [334]);
        await s.send(b64(settings.password), [235]);
      }
    }

    await s.send(`MAIL FROM:<${settings.from_address}>`, [250]);
    await s.send(`RCPT TO:<${msg.to}>`, [250, 251]);
    await s.send("DATA", [354]);

    const boundary = `cl_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const fromHeader = settings.from_name
      ? `=?UTF-8?B?${b64(settings.from_name)}?= <${settings.from_address}>`
      : settings.from_address;

    const headers = [
      `From: ${fromHeader}`,
      `To: <${msg.to}>`,
      msg.replyTo
        ? `Reply-To: ${formatReplyTo(msg.replyTo)}`
        : settings.reply_to
          ? `Reply-To: <${settings.reply_to}>`
          : null,
      `Subject: ${headerEncode(msg.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${boundary}@${ehloName}>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ...Object.entries(msg.headers ?? {}).map(
        ([k, v]) => `${k}: ${v}`,
      ),
    ].filter(Boolean) as string[];

    const body = [
      headers.join("\r\n"),
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64Lines(msg.text),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64Lines(msg.html),
      `--${boundary}--`,
      "",
      ".",
      "",
    ].join("\r\n");

    await s.sendRaw(body);
    await s.expect([250]);
    // DATA 250 is the delivery commit point. Do not wait for QUIT: a stalled
    // courtesy reply must not turn an accepted message into a retry/duplicate.
  } finally {
    // Closing is best effort and cannot hold the delivery result hostage.
    void wire.close().catch(() => {});
  }
}

/* --------------------------------------------------------------- settings */

/**
 * Built-in credentials from server secrets. Used whenever the console row is
 * absent or disabled, so email works without any admin input.
 */
export function envSmtpSettings(): SmtpSettings | null {
  const host = (process.env["SMTP_HOST"] ?? "").trim();
  const from_address = (process.env["SMTP_FROM_ADDRESS"] ?? "").trim().toLowerCase();
  const password = process.env["SMTP_PASSWORD"] ?? "";
  const portValue = process.env["SMTP_PORT"];
  const encValue = process.env["SMTP_ENCRYPTION"];
  // Only omitted values are inferred. Explicit empty/malformed values are
  // configuration errors, not an invitation to silently choose another port.
  if (portValue !== undefined && !/^\d+$/.test(portValue.trim())) fail("Invalid SMTP port");
  const rawPort = portValue === undefined ? undefined : Number(portValue);
  if (rawPort !== undefined && (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535)) fail("Invalid SMTP port");
  const rawEnc = encValue?.trim().toLowerCase();
  if (rawEnc !== undefined && !["none", "ssl", "starttls"].includes(rawEnc)) fail("Invalid SMTP encryption");
  if (!host && !from_address) return null;
  if (!host || !from_address) fail("Incomplete SMTP environment configuration");
  const encryption: SmtpEncryption =
    rawEnc === "none" || rawEnc === "ssl" || rawEnc === "starttls"
      ? rawEnc
      : rawPort === 465
        ? "ssl"
        : rawPort === 25
          ? "none"
          : "starttls";
  const port =
    rawPort !== undefined
      ? rawPort
      : encryption === "ssl"
        ? 465
        : encryption === "none"
          ? 25
          : 587;

  const settings: SmtpSettings = {
    host,
    port,
    username: (process.env["SMTP_USERNAME"] ?? "").trim(),
    password,
    from_name: (process.env["SMTP_FROM_NAME"] ?? "ConnectLive").trim(),
    from_address,
    reply_to: (process.env["SMTP_REPLY_TO"] ?? from_address).trim().toLowerCase(),
    encryption,
    enabled: true,
    updated_at: new Date(0).toISOString(),
  };
  validateSmtpSettings(settings);
  return settings;
}

/** Which source the mailer will use right now. */
export async function resolveSmtpSource(): Promise<{
  source: "custom" | "builtin" | "none";
  settings: SmtpSettings | null;
}> {
  let data: unknown;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const result = await supabaseAdmin
      .from("smtp_settings")
      .select(
        "host, port, username, password, from_name, from_address, reply_to, encryption, enabled, updated_at",
      )
      .eq("id", true)
      .maybeSingle();
    if (result.error) fail("SMTP settings could not be loaded");
    data = result.data;
  } catch {
    fail("SMTP settings could not be loaded");
  }

  const row = data as unknown as SmtpSettings | null;
  if (row && row.enabled) {
    validateSmtpSettings(row);
    return { source: "custom", settings: row };
  }
  const env = envSmtpSettings();
  return env ? { source: "builtin", settings: env } : { source: "none", settings: null };
}

/** Resolve the active SMTP credentials. Returns null when nothing is usable. */
export async function loadSmtpSettings(): Promise<SmtpSettings | null> {
  return (await resolveSmtpSource()).settings;
}

