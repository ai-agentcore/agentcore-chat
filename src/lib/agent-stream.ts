import { readSSE } from "./sse";
import type { AgentEvent, ChatMessage, RunActivity, ToolActivity } from "./types";
import { describeFile, FILE_REFERENCE_PATTERN, normalizeFileReference } from "./files";
import { isFailedToolResult } from "./tool-result";

const string = (value: unknown) => typeof value === "string" ? value : "";

interface PublishedArtifact { path: string; name: string }

type InternalRunActivity =
  | { id: string; type: "reasoning"; sourceId: string; content: string }
  | { id: string; type: "tool"; toolId: string };

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalArtifactLink(artifact: PublishedArtifact) {
  const prefix = describeFile(artifact.name).kind === "image" ? "!" : "";
  const label = artifact.name.replace(/[\[\]\\]/g, "\\$&");
  return `${prefix}[${label}](<${artifact.path}>)`;
}

/** Replace model-authored links with the trusted name/path returned by publish_artifact. */
function canonicalizeArtifactLink(content: string, artifact: PublishedArtifact) {
  const path = escapePattern(artifact.path);
  const target = `(?:${path}|https?:\\/\\/[^\\s<>()/]+${path})`;
  const markdown = new RegExp(`!?\\[[^\\]\\n]*\\]\\(\\s*(?:<${target}>|${target})(?:\\s+"[^"]*")?\\s*\\)`, "g");
  let found = false;
  const canonical = canonicalArtifactLink(artifact);
  const replaced = content.replace(markdown, () => { found = true; return canonical; });
  return { content: replaced, found };
}

function publishedArtifact(value: unknown, depth = 0): PublishedArtifact | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "string") {
    try { return publishedArtifact(JSON.parse(value), depth + 1); }
    catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = publishedArtifact(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.artifact && typeof record.artifact === "object") {
    const artifact = record.artifact as Record<string, unknown>;
    if (typeof artifact.path === "string") {
      try {
        const path = normalizeFileReference(artifact.path);
        if (!FILE_REFERENCE_PATTERN.test(path) && !path.startsWith("/mnt/oss/data/")) return undefined;
        const suppliedName = typeof artifact.name === "string" ? artifact.name : "";
        const name = FILE_REFERENCE_PATTERN.test(path) ? suppliedName : describeFile(path).name;
        if (!name || name.length > 255 || /[\\/\u0000-\u001f\u007f<>|`]/.test(name)) return undefined;
        return { path, name };
      } catch { return undefined; }
    }
  }
  for (const key of ["structuredContent", "content", "text", "result"]) {
    const found = publishedArtifact(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function contentWithArtifacts(content: string, artifacts: Iterable<PublishedArtifact>) {
  for (const artifact of artifacts) {
    const normalized = canonicalizeArtifactLink(content, artifact);
    content = normalized.content;
    // A path mentioned only as prose does not carry the verified filename,
    // so append one canonical reference for the renderer.
    if (!normalized.found) content += `${content ? "\n\n" : ""}${canonicalArtifactLink(artifact)}`;
  }
  return content;
}

/** Rehydrate canonical artifact links in conversations saved by older clients. */
export function restorePublishedArtifactLinks(content: string, tools: Iterable<ToolActivity> = []) {
  const artifacts: PublishedArtifact[] = [];
  for (const tool of tools) {
    if (!tool.name.includes("publish_artifact") || tool.result === undefined) continue;
    const artifact = publishedArtifact(tool.result);
    if (artifact) artifacts.push(artifact);
  }
  return contentWithArtifacts(content, artifacts);
}

/** One response may contain several AG-UI messages, tool calls and reasoning events. */
export class AgentRun {
  private texts = new Map<string, string>();
  private roles = new Map<string, string>();
  private tools = new Map<string, ToolActivity>();
  private currentMessage = "default";
  private currentTool = "";
  private reasoningParts = new Map<string, { content: string; promotable: boolean }>();
  private reasoningOrder: string[] = [];
  private currentReasoning = "default-reasoning";
  private pendingPromotions = new Set<string>();
  private runActivities: InternalRunActivity[] = [];
  private timelineTools = new Set<string>();
  private timelineSequence = 0;
  private artifacts = new Map<string, PublishedArtifact>();
  finished = false;

  private appendReasoning(id: string, delta: string, promotable: boolean): void {
    const existing = this.reasoningParts.get(id);
    if (!existing) this.reasoningOrder.push(id);
    this.reasoningParts.set(id, {
      content: (existing?.content || "") + delta,
      promotable: existing?.promotable ?? promotable,
    });
    if (!delta) return;
    const latest = this.runActivities.at(-1);
    if (latest?.type === "reasoning" && latest.sourceId === id) latest.content += delta;
    else this.runActivities.push({
      id: `reasoning-${++this.timelineSequence}`,
      type: "reasoning",
      sourceId: id,
      content: delta,
    });
  }

  private ensureToolActivity(id: string): void {
    if (!id || this.timelineTools.has(id)) return;
    this.timelineTools.add(id);
    this.runActivities.push({ id: `tool-${id}`, type: "tool", toolId: id });
  }

  private removeReasoningActivity(id: string): void {
    this.reasoningParts.delete(id);
    this.runActivities = this.runActivities.filter((activity) => activity.type !== "reasoning" || activity.sourceId !== id);
  }

  apply(event: AgentEvent): void {
    if (event.type === "RUN_ERROR") {
      const message = string(event.message);
      if (/AG-UI v1 does not support non-text Message or Tool Result output/i.test(message)) {
        throw new Error("Agent 尝试直接发送图片或附件，但当前通道只支持文本。请重试，让 Agent 通过 publish_artifact 发布文件并返回 artifact.path 或 Markdown 链接；图片会在对话中显示。");
      }
      throw new Error(message || "Agent 处理失败，请重试。");
    }
    if (event.type === "RUN_FINISHED") {
      this.finished = true;
      return;
    }
    if (event.type === "TEXT_MESSAGE_START") {
      this.currentMessage = string(event.messageId) || "default";
      this.roles.set(this.currentMessage, string(event.role) || "assistant");
      if (this.reasoningParts.get(this.currentMessage)?.promotable) this.pendingPromotions.add(this.currentMessage);
    }
    if (event.type === "TEXT_MESSAGE_CONTENT" || event.type === "TEXT_MESSAGE_CHUNK") {
      this.currentMessage = string(event.messageId) || this.currentMessage;
      if (event.role) this.roles.set(this.currentMessage, string(event.role));
      if ((this.roles.get(this.currentMessage) || "assistant") === "assistant") {
        const delta = string(event.delta);
        if (this.pendingPromotions.delete(this.currentMessage)) {
          this.removeReasoningActivity(this.currentMessage);
          this.texts.set(this.currentMessage, delta);
        } else this.texts.set(this.currentMessage, (this.texts.get(this.currentMessage) || "") + delta);
      }
    }
    if (["THINKING_TEXT_MESSAGE_START", "REASONING_MESSAGE_START"].includes(event.type)) {
      this.currentReasoning = string(event.messageId)
        || (event.type === "THINKING_TEXT_MESSAGE_START" ? "default-activity" : "default-reasoning");
    }
    if (["THINKING_TEXT_MESSAGE_CONTENT", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_CHUNK"].includes(event.type)) {
      const id = string(event.messageId) || this.currentReasoning;
      this.currentReasoning = id;
      this.appendReasoning(id, string(event.delta), event.type === "THINKING_TEXT_MESSAGE_CONTENT");
    }
    if (event.type === "TOOL_CALL_START" || event.type === "TOOL_CALL_CHUNK" || event.type === "TOOL_CALL_ARGS") {
      this.currentTool = string(event.toolCallId) || this.currentTool;
      if (this.currentTool) {
        this.ensureToolActivity(this.currentTool);
        const previous = this.tools.get(this.currentTool);
        this.tools.set(this.currentTool, {
          ...previous, id: this.currentTool, name: string(event.toolCallName) || previous?.name || "工具", status: previous?.status || "running",
          arguments: (previous?.arguments || "") + (event.type === "TOOL_CALL_START" ? "" : string(event.delta)),
        });
      }
    }
    if (event.type === "TOOL_CALL_RESULT") {
      const id = string(event.toolCallId);
      if (!id) return;
      this.ensureToolActivity(id);
      const tool = this.tools.get(id);
      const result = typeof event.content === "string" ? event.content : event.content === undefined ? undefined : JSON.stringify(event.content, null, 2);
      const name = tool?.name || string(event.toolCallName) || "工具";
      const isError = event.isError === true || isFailedToolResult(event.content);
      this.tools.set(id, { ...tool, id, name, status: "complete", result, isError });
      if (!isError && name.includes("publish_artifact")) {
        const artifact = publishedArtifact(event.content);
        if (artifact) this.artifacts.set(artifact.path, artifact);
      }
    }
  }

  snapshot(): Pick<ChatMessage, "content" | "reasoning" | "tools" | "runActivities"> {
    let content = [...this.texts.values()].filter(Boolean).join("\n\n");
    content = contentWithArtifacts(content, this.artifacts.values());
    return {
      content,
      reasoning: this.reasoningOrder.flatMap((id) => {
        const content = this.reasoningParts.get(id)?.content;
        return content ? [content] : [];
      }).join("\n\n"),
      tools: [...this.tools.values()],
      runActivities: this.runActivities.map((activity): RunActivity => activity.type === "reasoning"
        ? { id: activity.id, type: activity.type, content: activity.content }
        : { id: activity.id, type: activity.type, toolId: activity.toolId }),
    };
  }
}

export async function consumeAgentStream(
  response: Response,
  onUpdate: (snapshot: ReturnType<AgentRun["snapshot"]>) => void,
): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(string(body?.error) || `请求失败（${response.status}），请稍后重试。`);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("服务未返回流式响应，请检查 Agent 接口配置。");
  }

  const run = new AgentRun();
  for await (const data of readSSE(response.body)) {
    if (data.trim() === "[DONE]") { run.finished = true; break; }
    let event: AgentEvent;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") {
        throw new Error("Invalid event");
      }
      event = parsed as AgentEvent;
    } catch {
      throw new Error("服务返回了无法解析的流式消息，请重试。");
    }
    run.apply(event);
    onUpdate(run.snapshot());
    if (run.finished) break;
  }
  if (!run.finished) throw new Error("连接提前断开，已保留收到的内容。请重新生成。");
  if (!run.snapshot().content.trim() && !run.snapshot().tools?.some((tool) => tool.result !== undefined)) throw new Error("Agent 未返回文本内容，请重试或换个问题。");
}
