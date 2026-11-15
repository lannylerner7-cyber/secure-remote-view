import { sha256 } from "@noble/hashes/sha2.js";
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES } from "@/shared/session-tools";

export const fileIdValid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
export const checksumValid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, "0")).join("");
export async function hashBlob(blob: Blob, current = () => true): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    if (!current()) throw new Error("authorization_changed");
    hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
  }
  if (!current()) throw new Error("authorization_changed");
  return hex(hash.digest());
}
/** Chunk identity is explicit; JSON-looking file bytes are never control frames. */
export function encodeFileChunk(id: string, sequence: number, data: ArrayBuffer): ArrayBuffer {
  if (!fileIdValid(id) || !Number.isSafeInteger(sequence) || sequence < 0 ||
      data.byteLength > FILE_CHUNK_BYTES) throw new Error("invalid_chunk");
  const packet = new Uint8Array(44 + data.byteLength);
  packet.set(new TextEncoder().encode(`CLF2${id}`));
  new DataView(packet.buffer).setUint32(40, sequence, true);
  packet.set(new Uint8Array(data), 44);
  return packet.buffer;
}
export function decodeFileChunk(packet: ArrayBuffer) {
  if (packet.byteLength < 45 || packet.byteLength > FILE_CHUNK_BYTES + 44) throw new Error("invalid_chunk");
  const bytes = new Uint8Array(packet);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "CLF2") throw new Error("invalid_chunk");
  const id = new TextDecoder().decode(bytes.subarray(4, 40));
  if (!fileIdValid(id)) throw new Error("invalid_chunk");
  return { id, sequence: new DataView(packet).getUint32(40, true), bytes: bytes.slice(44) };
}
export type FileDescription = { id: string; name: string; size: number; sha256: string; mime: string };
export function fileDescription(value: Record<string, unknown>): FileDescription {
  if (!fileIdValid(value.id) || !Number.isSafeInteger(value.size) ||
      Number(value.size) < 0 || Number(value.size) > MAX_FILE_BYTES || !checksumValid(value.sha256) ||
      typeof value.name !== "string" || value.name.length < 1 || value.name.length > 180 ||
      /[\\/\x00-\x1f]/.test(value.name) || typeof value.mime !== "string" || value.mime.length > 128)
    throw new Error("invalid_file_metadata");
  return value as FileDescription;
}

/** Incremental validation, used by the actual browser receiver and fixtures. */
export class FileIntegrity {
  private hash = sha256.create();
  received = 0;
  sequence = 0;
  constructor(readonly file: FileDescription) {}
  append(sequence: number, data: Uint8Array) {
    if (sequence !== this.sequence || data.length === 0 || data.length > FILE_CHUNK_BYTES ||
        this.received + data.length > this.file.size) throw new Error("incomplete_or_reordered_file");
    this.hash.update(data); this.received += data.length; this.sequence++;
  }
  finish(chunks: number, checksum: string) {
    if (chunks !== this.sequence || this.received !== this.file.size || checksum !== this.file.sha256 ||
        hex(this.hash.digest()) !== checksum) throw new Error("file_integrity_failed");
  }
}
