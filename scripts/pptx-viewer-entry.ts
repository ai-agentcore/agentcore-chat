import JSZip from "jszip";
import { init } from "pptx-preview";

const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const SLIDE_LAYOUT_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const SLIDE_MASTER_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const SLIDE_LAYOUT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
const SLIDE_MASTER_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";
const THEME_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.theme+xml";

function parseXml(value: string, message: string): XMLDocument {
  const document = new DOMParser().parseFromString(value, "application/xml");
  if (document.querySelector("parsererror")) throw new Error(message);
  return document;
}

function relationshipPart(part: string): string {
  const segments = part.split("/");
  const name = segments.pop()!;
  return [...segments, "_rels", `${name}.rels`].join("/");
}

function resolveRelationshipTarget(owner: string, target: string): string | undefined {
  if (!target || target.startsWith("/") || target.includes("\\")) return undefined;
  const segments = owner.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return undefined;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join("/");
}

function relativeRelationshipTarget(owner: string, target: string): string {
  const from = owner.split("/").slice(0, -1);
  const to = target.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  return [...Array(from.length - shared).fill(".."), ...to.slice(shared)].join("/");
}

function nextRelationshipId(relationships: Element[]): string {
  const used = new Set(relationships.map((relationship) => relationship.getAttribute("Id")));
  let number = 1;
  while (used.has(`rId${number}`)) number++;
  return `rId${number}`;
}

async function repairLayoutMasterRelationships(archive: JSZip, layouts: string[], masters: string[]): Promise<boolean> {
  const mastersByLayout = new Map<string, Set<string>>();
  for (const master of masters) {
    const entry = archive.file(relationshipPart(master));
    if (!entry) continue;
    const document = parseXml(await entry.async("string"), "Invalid master relationships");
    for (const relationship of Array.from(document.getElementsByTagName("Relationship"))) {
      if (relationship.getAttribute("Type") !== SLIDE_LAYOUT_RELATIONSHIP || relationship.getAttribute("TargetMode") === "External") continue;
      const layout = resolveRelationshipTarget(master, relationship.getAttribute("Target") || "");
      if (!layout) continue;
      const candidates = mastersByLayout.get(layout) ?? new Set<string>();
      candidates.add(master);
      mastersByLayout.set(layout, candidates);
    }
  }

  let changed = false;
  for (const layout of layouts) {
    const part = relationshipPart(layout);
    const entry = archive.file(part);
    const document = entry
      ? parseXml(await entry.async("string"), "Invalid layout relationships")
      : parseXml(`<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}"/>`, "Invalid layout relationships");
    const relationships = Array.from(document.getElementsByTagName("Relationship"));
    if (relationships.some((relationship) => relationship.getAttribute("Type") === SLIDE_MASTER_RELATIONSHIP)) continue;
    const candidates = [...(mastersByLayout.get(layout) ?? [])];
    if (candidates.length !== 1) continue;
    const relationship = document.createElementNS(RELATIONSHIPS_NAMESPACE, "Relationship");
    relationship.setAttribute("Id", nextRelationshipId(relationships));
    relationship.setAttribute("Type", SLIDE_MASTER_RELATIONSHIP);
    relationship.setAttribute("Target", relativeRelationshipTarget(layout, candidates[0]));
    document.documentElement.appendChild(relationship);
    archive.file(part, new XMLSerializer().serializeToString(document));
    changed = true;
  }
  return changed;
}

async function repairSingletonThemeLineStyles(archive: JSZip, themes: string[]): Promise<boolean> {
  let changed = false;
  for (const theme of themes) {
    const entry = archive.file(theme);
    if (!entry) continue;
    const document = parseXml(await entry.async("string"), "Invalid theme");
    let themeChanged = false;
    for (const list of Array.from(document.getElementsByTagNameNS("*", "lnStyleLst"))) {
      const lines = Array.from(list.children).filter((child) => child.localName === "ln");
      if (lines.length !== 1) continue;
      while (Array.from(list.children).filter((child) => child.localName === "ln").length < 3) {
        list.appendChild(lines[0].cloneNode(true));
      }
      themeChanged = true;
    }
    if (themeChanged) {
      archive.file(theme, new XMLSerializer().serializeToString(document));
      changed = true;
    }
  }
  return changed;
}

/** Runs only inside the isolated preview frame. */
export async function load(container: HTMLElement, buffer: ArrayBuffer) {
  const archive = await JSZip.loadAsync(buffer);
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > 5000) throw new Error("Too many archive entries");
  let expandedBytes = 0;
  for (const entry of entries) {
    // JSZip 3.10.1 records the ZIP directory's size before decompressing entries.
    const size = (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid archive size");
    expandedBytes += size;
    if (expandedBytes > 100 * 1024 * 1024) throw new Error("Expanded archive too large");
  }
  const types = archive.file("[Content_Types].xml");
  if (!types) throw new Error("Missing content types");
  const document = parseXml(await types.async("string"), "Invalid content types");
  let slides = 0;
  let changed = false;
  const layouts: string[] = [];
  const masters: string[] = [];
  const themes: string[] = [];
  for (const item of Array.from(document.getElementsByTagName("Override"))) {
    const part = (item.getAttribute("PartName") || "").replace(/^\//, "");
    const contentType = item.getAttribute("ContentType");
    const isSlide = contentType === "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
    if (isSlide) slides++;
    if (contentType === SLIDE_LAYOUT_CONTENT_TYPE) layouts.push(part);
    if (contentType === SLIDE_MASTER_CONTENT_TYPE) masters.push(part);
    if (contentType === THEME_CONTENT_TYPE) themes.push(part);
    if (!archive.file(part)) {
      if (isSlide) throw new Error("Missing slide");
      // PptxGenJS can declare unused masters that are absent from the ZIP.
      // Remove these stale declarations from the in-memory preview copy only.
      item.remove(); changed = true;
    }
  }
  if (!slides || slides > 200) throw new Error("Invalid slide count");
  if (changed) archive.file("[Content_Types].xml", new XMLSerializer().serializeToString(document));
  changed = await repairLayoutMasterRelationships(archive, layouts, masters) || changed;
  changed = await repairSingletonThemeLineStyles(archive, themes) || changed;
  const input = changed ? await archive.generateAsync({ type: "arraybuffer" }) : buffer;
  const viewer = init(container, { width: 960, height: 540, mode: "slide" });
  await viewer.load(input);
  // The upstream parser may swallow errors; never report a partial deck as complete.
  if (viewer.slideCount !== slides) { viewer.destroy(); throw new Error("Incomplete slide parsing"); }
  return viewer;
}
