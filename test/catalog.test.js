import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadCatalog } from "../src/catalog.js";

test("基础目录可以读取", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entries = loadCatalog(path.join(here, "..", "fixtures", "catalog.json"));
  assert.ok(entries.length >= 2);
});
