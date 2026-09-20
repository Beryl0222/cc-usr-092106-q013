import fs from "node:fs";

// 读取业务基础目录，并核对标识与名称。
export function loadCatalog(filePath) {
  const entries = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.id || !entry.name) throw new Error("目录条目缺少标识或名称");
    if (seen.has(entry.id)) throw new Error(`目录标识重复: ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
}
