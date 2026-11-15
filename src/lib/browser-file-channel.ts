import { decodeFileChunk, encodeFileChunk, FileIntegrity, fileDescription, hashBlob, type FileDescription } from "./file-integrity";
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES, MAX_SESSION_BYTES, type ToolBinding } from "@/shared/session-tools";
import type { FileTransferEvent } from "./webrtc-live";

type Sink = { write(bytes: Uint8Array): Promise<void>; finish(mime: string): Promise<Blob>; dispose(): Promise<void> };
async function createSink(id: string, size: number): Promise<Sink> {
  // OPFS avoids a 500 MiB heap allocation. Unsupported browsers have an explicit,
  // small fallback limit, not silent unbounded buffering.
  if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
    const directory = await navigator.storage.getDirectory();
    const filename = `connectlive-transfer-${id}`;
    const file = await directory.getFileHandle(filename, { create: true });
    const writer = await file.createWritable();
    let closed = false;
    return {
      write: bytes => writer.write(bytes as Uint8Array<ArrayBuffer>),
      async finish() { await writer.close(); closed = true; return file.getFile(); },
      async dispose() {
        if (!closed) await writer.abort().catch(() => {});
        await directory.removeEntry(filename).catch(() => {});
      },
    };
  }
  if (size > 16 * 1024 * 1024) throw new Error("This browser cannot safely buffer this file. Use a browser with local file storage.");
  const parts: BlobPart[] = [];
  return {
    async write(bytes) { parts.push(bytes.slice().buffer); },
    async finish(mime) { return new Blob(parts, { type: mime }); },
    async dispose() { parts.length = 0; },
  };
}

export function createBrowserFileChannel(channel: RTCDataChannel, binding: ToolBinding,
  current: () => boolean, emit: (event: FileTransferEvent) => void, allowed: () => boolean = current) {
  let ready = false, closed = false, used = 0, pendingCount = 0;
  let sequence = Promise.resolve();
  let receiving: { info: FileDescription; integrity: FileIntegrity; sink: Sink } | null = null;
  let sending: { id: string; size: number; sha256: string; ack: number; complete: boolean; error: string | null } | null = null;
  const seen = new Set<string>();
  const expected = new Map<string, { resolve: (value: Blob) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const valid = () => !closed && current() && channel.readyState === "open";
  const send = (type: string, value: unknown) => {
    if (!valid()) throw new Error("File authority or connection changed.");
    channel.send(JSON.stringify({ type, version: 1, binding, value }));
  };
  const matches = (v: Record<string, unknown>) => v.version === 1 && v.binding &&
    Object.entries(binding).every(([k, value]) => (v.binding as Record<string, unknown>)[k] === value);
  const finishExpected = (id: string, error: Error | null, blob?: Blob) => {
    const pending = expected.get(id); if (!pending) return;
    expected.delete(id); clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(blob!);
  };
  async function failIncoming(message: string) {
    const old = receiving; receiving = null;
    if (!old) return;
    await old.sink.dispose();
    finishExpected(old.info.id, new Error(message));
    emit({ kind: "error", id: old.info.id, name: old.info.name, message });
    try { send("error", { id: old.info.id, reason: "file_integrity_failed" }); } catch {}
  }
  channel.binaryType = "arraybuffer";
  channel.onopen = () => { try { send("hello", {}); } catch {} };
  channel.onmessage = event => {
    if (!valid() || ++pendingCount > 32) { close(); return; }
    sequence = sequence.then(async () => {
      if (!valid()) return;
      if (!allowed() && typeof event.data !== "string") throw new Error("File access is paused for verification.");
      if (typeof event.data !== "string") {
        if (!(event.data instanceof ArrayBuffer) || !receiving) throw new Error("Unexpected file bytes.");
        const chunk = decodeFileChunk(event.data);
        if (chunk.id !== receiving.info.id) throw new Error("File identity changed.");
        const r = receiving;
        r.integrity.append(chunk.sequence, chunk.bytes);
        await r.sink.write(chunk.bytes);
        if (!valid() || receiving !== r) throw new Error("File transfer cancelled.");
        send("chunk_ack", { id: r.info.id, sequence: chunk.sequence });
        emit({ kind: "progress", id: r.info.id, name: r.info.name, size: r.info.size, sent: r.integrity.received });
        return;
      }
      if (event.data.length > 8192) throw new Error("Invalid file receipt.");
      const envelope = JSON.parse(event.data) as Record<string, unknown>;
      if (!matches(envelope)) return;
      const type = envelope.type, v = envelope.value as Record<string, unknown>;
      if (type === "ready") { ready = v.protocol === 2; return; }
      if (type === "begin") {
        if (!allowed()) throw new Error("File access is paused for verification.");
        const info = fileDescription(v);
        if (!expected.has(info.id) || receiving || seen.has(info.id) || seen.size >= 512 ||
            used + info.size > MAX_SESSION_BYTES) throw new Error("Unexpected file or session quota exceeded.");
        seen.add(info.id); used += info.size;
        const sink = await createSink(info.id, info.size);
        if (!valid() || !allowed() || !expected.has(info.id)) { await sink.dispose(); throw new Error("File cancelled or connection changed."); }
        receiving = { info, integrity: new FileIntegrity(info), sink };
        send("accepted", { id: info.id });
        emit({ kind: "begin", id: info.id, name: info.name, size: info.size });
      } else if (type === "end" && receiving) {
        const r = receiving;
        if (v.id !== r.info.id) throw new Error("File identity changed.");
        r.integrity.finish(Number(v.chunks), String(v.sha256));
        const blob = await r.sink.finish(r.info.mime);
        if (!valid() || receiving !== r) throw new Error("File authority changed.");
        receiving = null;
        send("complete", { id: r.info.id, size: r.info.size, sha256: r.info.sha256 });
        emit({ kind: "complete", id: r.info.id, name: r.info.name, size: r.info.size, blob });
        finishExpected(r.info.id, null, blob);
        // Give the deliberate download time to consume its file snapshot.
        setTimeout(() => { void r.sink.dispose(); }, 60_000);
      } else if (type === "error" || type === "cancelled") {
        if (sending && (!v.id || v.id === sending.id)) sending.error = "The Agent rejected or cancelled the file. No automatic retry.";
        if (receiving && (!v.id || v.id === receiving.info.id)) await failIncoming("Remote file was cancelled or changed.");
        if (typeof v.id === "string") finishExpected(v.id, new Error("Remote file was cancelled or changed."));
      } else if (sending && v.id === sending.id) {
        if (type === "accepted") sending.ack = -1;
        if (type === "chunk_ack" && Number.isInteger(v.sequence)) {
          if (Number(v.sequence) === sending.ack + 1 || Number(v.sequence) === sending.ack) sending.ack = Number(v.sequence);
          else sending.error = "File sequence acknowledgement invalid.";
        }
        if (type === "complete" && v.size === sending.size && v.sha256 === sending.sha256) sending.complete = true;
      }
    }).catch(async error => {
      if (receiving) await failIncoming("File integrity or connection failed. No incomplete download was saved.");
      else for (const id of expected.keys()) {
        finishExpected(id,new Error(error instanceof Error ? error.message : "File storage or connection unavailable."));
        try { send("error",{id,reason:"file_rejected"}); } catch {}
      }
    })
      .finally(() => { pendingCount--; });
  };
  channel.onclose = () => close();
  async function wait(predicate: () => boolean, signal?: AbortSignal) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (!valid() || !allowed() || signal?.aborted || sending?.error || Date.now() >= deadline)
        throw new Error(sending?.error ?? "File receipt unconfirmed. Do not retry an uncertain write automatically.");
      if (predicate()) return;
      await new Promise(r => setTimeout(r, 10));
    }
  }
  function cancel(id: string) {
    try { send("cancel", { id }); } catch {}
    finishExpected(id, new Error("Download cancelled."));
    if (receiving?.info.id === id) void failIncoming("Download cancelled.");
    if (sending?.id === id) sending.error = "Upload cancelled.";
  }
  function close() {
    if (closed) return;
    closed = true; ready = false;
    if (sending) sending.error = "File connection closed; delivery is unconfirmed.";
    for (const id of expected.keys()) finishExpected(id, new Error("File connection closed."));
    void failIncoming("File connection closed.");
    try { channel.close(); } catch {}
  }
  return {
    ready: () => ready && valid() && allowed(),
    async sendFile(file: File, signal?: AbortSignal): Promise<boolean> {
      if (!ready || !valid() || !allowed()) return false;
      if (sending || file.size > MAX_FILE_BYTES || used + file.size > MAX_SESSION_BYTES || seen.size >= 512)
        throw new Error("Transfer busy or the 500 MiB / 5 GiB limit was reached.");
      const id = crypto.randomUUID();
      sending = { id, size:file.size, sha256:"", ack: -2, complete: false, error: null };
      seen.add(id); used += file.size;
      let endSent = false;
      try {
        const checksum = await hashBlob(file, () => valid() && allowed() && !signal?.aborted && !sending?.error);
        sending.sha256 = checksum;
        send("begin", { id, name: file.name.replace(/[\\/\x00-\x1f]/g, "_").slice(0,180), size: file.size, sha256: checksum,
          mime: (file.type || "application/octet-stream").slice(0,128) });
        emit({ kind: "begin", id, name: file.name, size: file.size });
        await wait(() => sending!.ack >= -1 || sending!.complete, signal);
        if (sending.complete) return true;
        let chunks = 0;
        for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
          if (!valid() || !allowed() || signal?.aborted || sending.error) throw new Error("Upload cancelled.");
          const bytes = await file.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer();
          if (!valid() || !allowed() || signal?.aborted || sending.error) throw new Error("Upload cancelled.");
          const seq = chunks++;
          channel.send(encodeFileChunk(id, seq, bytes));
          await wait(() => sending!.ack >= seq, signal);
          emit({ kind: "progress", id, name: file.name, size: file.size, sent: offset + bytes.byteLength });
        }
        send("end", { id, chunks, sha256: checksum }); endSent = true;
        await wait(() => sending!.complete, signal);
        emit({ kind: "sent", id, name: file.name, size: file.size });
        return true;
      } catch (error) {
        if (!endSent) cancel(id);
        const message = endSent ? "Delivery result unconfirmed. No automatic fallback or retry was made." :
          error instanceof Error ? error.message : "File transfer failed.";
        emit({ kind: "error", id, name: file.name, message });
        throw new Error(message);
      } finally { sending = null; }
    },
    expect(id: string, signal?: AbortSignal): Promise<Blob> {
      if (!ready || !valid() || signal?.aborted || expected.size) return Promise.reject(new Error("Verified file channel unavailable or busy."));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => cancel(id), 30 * 60_000);
        expected.set(id, { resolve, reject, timer });
        signal?.addEventListener("abort", () => cancel(id), { once: true });
      });
    },
    cancel, close,
    suspend() { if (sending) cancel(sending.id); for (const id of expected.keys()) cancel(id); },
  };
}
