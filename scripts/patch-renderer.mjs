import { readFileSync, writeFileSync } from "node:fs";

// react-ai-renderer 0.1.27 inserts keyless Markdown elements into FallbackView's
// array. Apply a narrow, repeatable compatibility fix instead of hiding React's
// warning. Both published entry points must behave identically after npm ci.
const packageRoot = new URL("../node_modules/react-ai-renderer/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
if (manifest.version !== "0.1.27") throw new Error("Review the renderer compatibility patch before upgrading react-ai-renderer.");

const before = "      finalComponent.push(_result);";
const after = "      finalComponent.push(React.isValidElement(_result) ? React.cloneElement(_result, { key: 'segment-' + i }) : _result);";
for (const name of ["dist/index.js", "dist/index.cjs"]) {
  const path = new URL(name, packageRoot);
  const source = readFileSync(path, "utf8");
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2) throw new Error(`Unexpected renderer source in ${name}; refusing to patch.`);
  writeFileSync(path, source.replace(before, after));
}
console.log("Applied react-ai-renderer 0.1.27 React key compatibility fix.");
