import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { resolve, relative, join, dirname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
export async function safeDirectory(path) {
  await mkdir(path, { recursive: true });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("UNSAFE_PATH");
  return path;
}
export async function containedPath(root, path, { allowMissing = false } = {}) {
  const base = resolve(root),
    target = resolve(path),
    rel = relative(base, target);
  if (rel.startsWith(".." + sep) || rel === ".." || rel.startsWith(sep))
    throw new Error("UNSAFE_PATH");
  const baseStat = await lstat(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory())
    throw new Error("UNSAFE_PATH");
  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) throw new Error("UNSAFE_PATH");
    } catch (e) {
      if (e.code === "ENOENT" && allowMissing) return target;
      throw e;
    }
  }
  return target;
}
export async function readRegular(root, path, maxBytes = 32 * 1024 * 1024, {allowEmpty=false}={}) {
  const target = await containedPath(root, path);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes || st.size < (allowEmpty?0:1))
      throw new Error("INVALID_FILE");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function atomicJson(path, value) {
  const temp = join(dirname(path), "." + randomUUID() + ".tmp");
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
