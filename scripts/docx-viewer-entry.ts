import JSZip from "jszip";
import { renderAsync } from "docx-preview";

/** Runs only in the opaque-origin Word preview frame. */
export async function load(container: HTMLElement, buffer: ArrayBuffer) {
  const archive = await JSZip.loadAsync(buffer);
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > 5000) throw new Error("Too many archive entries");
  let expandedBytes = 0;
  for (const entry of entries) {
    // The pinned JSZip version exposes ZIP directory sizes before decompression.
    const size = (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid archive size");
    expandedBytes += size;
    if (expandedBytes > 100 * 1024 * 1024) throw new Error("Expanded archive too large");
  }
  if (!archive.file("[Content_Types].xml") || !archive.file("word/document.xml")) throw new Error("Not a Word document");
  const xml = new DOMParser().parseFromString(await archive.file("word/document.xml")!.async("string"), "application/xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "document") throw new Error("Invalid Word document");

  await renderAsync(buffer, container, undefined, {
    className: "docx", breakPages: true, ignoreLastRenderedPageBreak: false,
    renderAltChunks: false, renderComments: false, renderChanges: false,
    useBase64URL: true, experimental: false,
  });
  const pages = container.querySelectorAll("section.docx");
  if (!pages.length || pages.length > 200) throw new Error("Invalid page count");
  return pages.length;
}
