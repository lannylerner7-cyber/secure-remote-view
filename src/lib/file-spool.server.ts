import { openAsBlob } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Small incremental heap use; ephemeral scratch bytes are always removed. */
export async function fileSpool() {
  const directory = await mkdtemp(join(tmpdir(),"connectlive-transfer-"));
  const path = join(directory,"bytes");
  let handle: FileHandle | null = await open(path,"wx",0o600), size = 0;
  const hash = createHash("sha256");
  return {
    async append(bytes: Uint8Array) {
      if (!handle) throw new Error("spool_closed");
      // write() can be short; a queued write is not the complete chunk.
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(bytes,offset,bytes.length-offset);
        if (!result.bytesWritten) throw new Error("spool_write_failed");
        offset += result.bytesWritten;
      }
      hash.update(bytes); size += bytes.length;
    },
    async finish() {
      await handle?.close(); handle = null;
      return { size,sha256:hash.digest("hex"),blob:await openAsBlob(path) };
    },
    async dispose() {
      await handle?.close().catch(()=>{}); handle=null;
      await rm(directory,{recursive:true,force:true}).catch(()=>{ console.warn("Transfer scratch cleanup failed."); });
    },
  };
}
export async function storedChecksum(blob: Blob) {
  const hash=createHash("sha256");
  for(let offset=0;offset<blob.size;offset+=1024*1024)
    hash.update(new Uint8Array(await blob.slice(offset,offset+1024*1024).arrayBuffer()));
  return hash.digest("hex");
}
