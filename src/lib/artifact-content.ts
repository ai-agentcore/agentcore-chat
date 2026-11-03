import { describeFile, normalizeFileReference } from "./files";

function card(path: string, name?: string) {
  try {
    const normalized = normalizeFileReference(path);
    return `\n\n<AgentFileArtifact filePath="${encodeURIComponent(normalized)}" fileName="${encodeURIComponent(name || describeFile(normalized).name)}" />\n\n`;
  } catch { return null; }
}

function pathCard(value: string) {
  const path = value.trim();
  if (!/^(?:(?:sandbox:)?\/mnt\/(?:oss\/data|agenticfs\/shared)\/[^\r\n<>|`]*\.[a-z0-9]{1,12}|\/f\/f_[A-Za-z0-9_-]{22})$/i.test(path)) return null;
  return card(path);
}

/** Convert explicit references while keeping source code and JSX examples literal. */
function transformText(text: string, streaming: boolean): string {
  const inlineCode: string[] = [];
  let result = text.replace(/(`+)([^`\n]+)\1/g, (original, _ticks: string, value: string) => {
    const replacement = (/^(?:sandbox:)?\/mnt\/(?:oss\/data|agenticfs\/shared)\//.test(value) && describeFile(value).extension) || /^\/f\/f_[A-Za-z0-9_-]{22}$/.test(value) ? card(value) || original : original;
    const index = inlineCode.push(replacement) - 1;
    return `\u0000INLINE${index}\u0000`;
  });
  result = result.replace(/<FileCard\b[\s\S]*?\/\s*>/g, (tag) => {
    // A deliberately small declarative contract: quoted string props only.
    const attributes = new Map<string, string>();
    const body = tag.replace(/^<FileCard\b/, "").replace(/\/\s*>$/, "");
    const leftover = body.replace(/\b(path|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_match, key: string, double: string, single: string) => {
      attributes.set(key, double ?? single); return "";
    });
    if (leftover.trim() || !attributes.has("path")) return "[文件引用格式无效]";
    const rendered = card(attributes.get("path")!, attributes.get("name"));
    if (!rendered) return "[文件路径无效]";
    return `\u0000INLINE${inlineCode.push(rendered) - 1}\u0000`;
  });
  result = result.replace(/<FileCard\b[\s\S]*$/, "");
  result = result.replace(/!?\[([^\]\n]*)\]\(\s*(?:<((?:(?:sandbox:)?\/mnt\/(?:oss\/data|agenticfs\/shared)\/[^>\n]+|\/f\/f_[A-Za-z0-9_-]{22}))>|((?:(?:sandbox:)?\/mnt\/(?:oss\/data|agenticfs\/shared)\/[^\s)]+|\/f\/f_[A-Za-z0-9_-]{22})))(?:\s+"[^"]*")?\s*\)/g,
    (original, name: string, anglePath: string, plainPath: string) => card(anglePath || plainPath, name) || original);
  // Hide incomplete custom elements/links until the stream supplies a full path.
  // react-ai-renderer caches streamable component props after its first render.
  result = result.replace(/!?\[[^\]\n]*\]\(\s*(?:<(?:(?:sandbox:)?\/mnt\/(?:oss\/data|agenticfs\/shared)\/|\/f\/)[^\n]*|(?:(?:sandbox:)?\/mnt\/(?:oss\/data|agenticfs\/shared)\/|\/f\/)[^)\n]*)$/, "");
  // A line containing only a path is a file reference, including names with
  // spaces. Wait for its newline/end-of-run before freezing component props.
  result = result.split(/(?<=\n)/).map((line) => streaming && !line.endsWith("\n") ? line : pathCard(line) || line).join("");
  return result.replace(/\u0000INLINE(\d+)\u0000/g, (_match, index: string) => inlineCode[Number(index)] || "");
}

export function prepareArtifactContent(content: string, streaming = false): string {
  const blocks: string[] = [];
  let plain = "";
  let fence: { char: string; length: number; opening: string; info: string; body: string } | null = null;
  const renderFence = (block: NonNullable<typeof fence>, closing: string) => {
    const lines = block.body.split(/\r?\n/).filter((line) => line.trim());
    const paths = lines.map(pathCard);
    // The screenshot's plain/text code block is a file delivery, not code.
    // Language-tagged programs, commands and FileCard examples stay untouched.
    return /^(?:text|txt|plaintext|path|file)?$/i.test(block.info) && paths.length && paths.every(Boolean)
      ? paths.join("") : block.opening + block.body + closing;
  };
  for (const line of content.split(/(?<=\n)/)) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence && match) {
      blocks.push(transformText(plain, streaming)); plain = "";
      fence = { char: match[1][0], length: match[1].length, opening: line, info: line.slice(match[0].length).trim(), body: "" };
    } else if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && line.slice(match[0].length).trim() === "") {
        blocks.push(renderFence(fence, line)); fence = null;
      } else fence.body += line;
    } else plain += line;
  }
  if (fence) blocks.push(streaming ? fence.opening + fence.body : renderFence(fence, ""));
  blocks.push(transformText(plain, streaming));
  return blocks.join("");
}

/**
 * react-ai-renderer 0.1.27 caches streamable components by their position and
 * does not refresh their props. Remount only when the rendered artifact tags
 * change, while allowing ordinary streamed text to keep the same renderer.
 */
export function artifactRenderKey(preparedContent: string): string {
  return [...preparedContent.matchAll(/<AgentFileArtifact\b[^>]*\/>/g)]
    .map((match) => match[0])
    .join("\u0000");
}
