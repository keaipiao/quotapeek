import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export async function createRuntimeManifest(root, entries) {
  const records = [];
  for (const entry of [...entries].sort()) {
    await visit(join(root, entry), root, records);
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  return records;
}

async function visit(path, root, records) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`Runtime sources may not contain symbolic links: ${path}`);
  if (stats.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), root, records);
    return;
  }
  if (!stats.isFile()) throw new Error(`Unsupported runtime source entry: ${path}`);
  const bytes = await readFile(path);
  records.push({
    path: relative(root, path).split(sep).join("/"),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

export function manifestDigest(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function assertSameManifest(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Installed runtime failed byte-content verification");
  }
}
