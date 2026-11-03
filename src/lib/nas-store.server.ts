import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { FileAccessError } from "./files";
import type { FileStore, StoredFileInfo } from "./file-store";
import { mountNasForUser, type NasMount } from "./nas-mount.server";
import type { UserIdentity } from "./sts-credentials.server";

function metadata(stat: BigIntStats): StoredFileInfo {
  if (!stat.isFile()) throw new FileAccessError(400, "NOT_A_FILE", "只能读取普通文件。");
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new FileAccessError(502, "INVALID_FILE_SIZE", "无法读取文件大小。");
  return { size, etag: `"${stat.dev}-${stat.ino}-${stat.size}-${stat.mtimeNs}-${stat.ctimeNs}"`, modifiedAt: stat.mtime.toUTCString() };
}

/** The mount provider owns authorization. Injectable only on the server for tests. */
export function createNasFileStore(identity: UserIdentity, acquire: () => Promise<NasMount> = () => mountNasForUser(identity)): FileStore {
  let mounted: Promise<NasMount> | undefined;
  let closing: Promise<void> | undefined;
  const handles = new Set<FileHandle>();
  const file = async (key: string) => {
    if (closing) throw new FileAccessError(502, "FILE_READ_FAILED", "文件读取已结束。");
    if (!key || key.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(key) || key.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new FileAccessError(400, "INVALID_PATH", "文件路径无效。");
    }
    const mount = await (mounted ||= acquire());
    const root = await realpath(mount.root);
    let target = root;
    for (const part of key.split("/")) {
      target = join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new FileAccessError(403, "SYMLINK_NOT_ALLOWED", "不支持预览符号链接，请使用实际文件。");
    }
    if (!target.startsWith(`${root}${sep}`) || await realpath(target) !== target) throw new FileAccessError(403, "FILE_FORBIDDEN", "文件不在共享工作区内。");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = metadata(await handle.stat({ bigint: true }));
      // Linux production: inspect the opened descriptor before returning any data.
      // This also catches parent-directory replacements during the checks above.
      if (process.platform === "linux") {
        const openedPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (openedPath !== resolve(target) || !openedPath.startsWith(`${root}/`)) throw new FileAccessError(403, "FILE_FORBIDDEN", "文件路径已改变，请重试。");
      }
      handles.add(handle);
      return { handle, info };
    } catch (error) { await handle.close(); throw error; }
  };
  const release = async (handle: FileHandle) => { handles.delete(handle); await handle.close(); };
  return {
    async stat(key) {
      const { handle, info } = await file(key);
      await release(handle);
      return info;
    },
    async read(key, { range, etag, signal }) {
      signal.throwIfAborted();
      const { handle, info } = await file(key);
      try {
        signal.throwIfAborted();
        if (etag && etag !== info.etag) throw new FileAccessError(409, "FILE_CHANGED", "文件已更新，请重新打开预览。");
        let start = 0;
        let end = info.size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) throw new FileAccessError(416, "INVALID_RANGE", "文件读取范围无效。");
          const from = match[1] ? Number(match[1]) : undefined;
          const to = match[2] ? Number(match[2]) : undefined;
          if ([from, to].some((value) => value !== undefined && !Number.isSafeInteger(value))) throw new FileAccessError(416, "INVALID_RANGE", "文件读取范围无效。");
          start = from === undefined ? Math.max(0, info.size - to!) : from;
          end = from === undefined || to === undefined ? end : Math.min(end, to);
          if (start > end || start >= info.size) throw new FileAccessError(416, "INVALID_RANGE", "文件读取范围无效。");
        }
        if (!info.size) {
          await release(handle);
          return { body: new ReadableStream({ start(controller) { controller.close(); } }), length: 0, status: 200 };
        }
        const stream = handle.createReadStream({ start, end, autoClose: true, signal });
        stream.once("close", () => handles.delete(handle));
        return { body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, length: end - start + 1,
          status: range ? 206 : 200, contentRange: range ? `bytes ${start}-${end}/${info.size}` : undefined };
      } catch (error) { await release(handle); throw error; }
    },
    close() {
      return closing ||= (async () => {
        await Promise.allSettled([...handles].map(release));
        // A rejected acquisition has already cleaned itself up (or never mounted).
        // Do not report that same acquisition failure as an unmount failure.
        const mount = await mounted?.catch(() => undefined);
        await mount?.close();
      })();
    },
  };
}
