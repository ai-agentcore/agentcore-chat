import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the published ESM entry with current dependency fixes, and serve it
// locally inside an opaque-origin iframe. No CDN or external viewer is used.
const destination = new URL("../public/file-viewers/", import.meta.url);
mkdirSync(destination, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./pptx-viewer-entry.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("pptx-preview-1.0.7.js", destination)),
  bundle: true, format: "iife", globalName: "pptxPreview", platform: "browser",
  target: "es2020", minify: true, logLevel: "warning",
});
await build({
  entryPoints: [fileURLToPath(new URL("./docx-viewer-entry.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("docx-preview-0.4.0.js", destination)),
  bundle: true, format: "iife", globalName: "docxPreview", platform: "browser",
  target: "es2020", minify: true, logLevel: "warning",
});
console.log("Prepared the local PPTX and DOCX preview runtimes.");
