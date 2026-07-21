import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertSameManifest, createRuntimeManifest, manifestDigest } from "../src/runtime-manifest.mjs";

test("runtime manifests are deterministic and byte-sensitive", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-manifest-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "one.mjs"), "export default 1;\n");
    const first = await createRuntimeManifest(root, ["src"]);
    const second = await createRuntimeManifest(root, ["src"]);
    assertSameManifest(first, second);
    assert.equal(manifestDigest(first), manifestDigest(second));
    await writeFile(join(root, "src", "one.mjs"), "export default 2;\n");
    const changed = await createRuntimeManifest(root, ["src"]);
    assert.throws(() => assertSameManifest(first, changed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
