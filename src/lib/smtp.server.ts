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

function cfWire(initial: CfSocket): Wire {
  let socket = initial;
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : (value ?? null);
    },
    async write(data) {
      await writer.write(data);
    },
    async startTls() {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await writer.close().catch(() => {});
      writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
    },
    async close() {
      try {
        await socket.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function nodeWire(host: string, port: number, tlsFromStart: boolean): Promise<Wire> {
  const net = await import("node:net");
  const tls = await import("node:tls");

  type Sock = import("node:net").Socket;
  let socket: Sock;
  const queue: Uint8Array[] = [];
  let waiter: ((v: Uint8Array | null) => void) | null = null;
  let ended = false;

  const attach = (s: Sock) => {
    s.on("data", (chunk: Buffer) => {
      const u8 = new Uint8Array(chunk);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(u8);
      } else queue.push(u8);
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

  socket = await new Promise<Sock>((resolve, reject) => {
    const s = tlsFromStart
      ? tls.connect({ host, port, servername: host }, () => resolve(s as unknown as Sock))
      : net.connect({ host, port }, () => resolve(s));
    s.once("error", reject);
  });
  attach(socket);

  return {
    read() {
      const next = queue.shift();
      if (next) return Promise.resolve(next);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    write(data) {
      return new Promise((resolve, reject) => {
        socket.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
      });
    },
    async startTls(servername) {
      const plain = socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("end");
      plain.removeAllListeners("close");
      socket = await new Promise<Sock>((resolve, reject) => {
        const s = tls.connect({ socket: plain, servername }, () => resolve(s as unknown as Sock));
        s.once("error", reject);
      });
      attach(socket);
    },
    async close() {
      try {
        socket.destroy();
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
      if (chunk === null) throw new Error("SMTP connection closed unexpectedly");
      this.buffer += dec.decode(chunk);
    }
  }

  async expect(codes: number[]): Promise<string> {
    const block = await this.readLineBlock();
    const code = Number(block.slice(0, 3));
    if (!codes.includes(code)) throw new Error(`SMTP ${block.replace(/\s+/g, " ").slice(0, 300)}`);
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

/** Send one message through the configured SMTP server. Throws on SMTP failure. */
export async function sendMail(settings: SmtpSettings, msg: MailMessage): Promise<void> {
  if (!settings.host || !settings.from_address) throw new Error("SMTP is not configured");

  const host = settings.host.trim();
  const port = Number(settings.port) || (settings.encryption === "ssl" ? 465 : 587);
  const implicitTls = settings.encryption === "ssl";

  const cf = await loadCloudflareSockets();
  let wire: Wire;
  if (cf) {
    wire = cfWire(
      cf.connect(
        { hostname: host, port },
        { secureTransport: implicitTls ? "on" : "starttls", allowHalfOpen: false },
      ),
    );
  } else {
    wire = await nodeWire(host, port, implicitTls);
  }

  const s = new SmtpSession(wire);
  try {
    await s.expect([220]);
    const ehloName = settings.from_address.split("@")[1] || "connectliveagent.com";
    let greeting = await s.send(`EHLO ${ehloName}`, [250]);

    if (settings.encryption === "starttls") {
      if (!/STARTTLS/i.test(greeting)) throw new Error("Server does not advertise STARTTLS");
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
      ? `${headerEncode(settings.from_name)} <${settings.from_address}>`
      : settings.from_address;

    const headers = [
      `From: ${fromHeader}`,
      `To: <${msg.to}>`,
      msg.replyTo
        ? `Reply-To: ${msg.replyTo.replace(/[\r\n]+/g, " ").trim()}`
        : settings.reply_to
          ? `Reply-To: <${settings.reply_to}>`
          : null,
      `Subject: ${headerEncode(msg.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${boundary}@${ehloName}>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ...Object.entries(msg.headers ?? {}).map(
        ([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, " ").trim()}`,
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
    await s.send("QUIT", [221, 250]).catch(() => undefined);
  } finally {
    await wire.close();
  }
}

/* --------------------------------------------------------------- settings */

/** Load the singleton SMTP row with the service role. Returns null when unusable. */
export async function loadSmtpSettings(): Promise<SmtpSettings | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("smtp_settings")
    .select(
      "host, port, username, password, from_name, from_address, reply_to, encryption, enabled, updated_at",
    )
    .eq("id", true)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as SmtpSettings;
  if (!row.enabled || !row.host || !row.from_address) return null;
  return row;
}
