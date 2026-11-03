"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import type { RunActivity as TimelineActivity, ToolActivity as Activity } from "@/lib/types";
import { AIRenderer } from "./ai-renderer";

function friendlyToolName(name: string) {
  const normalized = name.replace(/^mcp__(?:agentcore|agentrun)__/, "");
  const labels: Record<string, string> = {
    bash: "执行命令", execute_shell_command: "执行命令", publish_artifact: "发布文件",
    view_image: "查看图片", imagegen: "生成图片", "image_gen.imagegen": "生成图片",
    send_file_to_user: "发送文件", generate_report: "生成报告", read_builtin_skill: "读取技能",
  };
  return labels[normalized] || normalized;
}

function ToolOutput({ content, dark, conversationId, raw = false }: { content: string; dark: boolean; conversationId: string; raw?: boolean }) {
  let formatted = content;
  let json = false;
  try {
    const value: unknown = JSON.parse(content);
    if (value !== null && typeof value === "object") { formatted = JSON.stringify(value, null, 2); json = true; }
  } catch { /* Streaming arguments and plain text need no JSON parsing. */ }
  return raw || json ? <pre className="tool-code">{formatted}</pre>
    : <div className="ai-content tool-result-content"><AIRenderer content={content} dark={dark} conversationId={conversationId} /></div>;
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes} 分 ${remainder} 秒` : `${seconds} 秒`;
}

function useElapsed(startedAt: number | undefined, completedAt: number | undefined, running: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!running && (startedAt === undefined || completedAt === undefined)) return "";
  return formatElapsed(Math.max(0, (completedAt ?? now) - (startedAt ?? now)));
}

function useProgressiveText(content: string, active: boolean) {
  const [visible, setVisible] = useState(() => active ? content.slice(0, 1) : content);
  const visibleRef = useRef(visible);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    const update = (next: string) => { visibleRef.current = next; setVisible(next); };
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!active || reducedMotion) { update(content); return; }
    if (!content.startsWith(visibleRef.current)) update(content.slice(0, 1));
    else if (!visibleRef.current && content) update(content.slice(0, 1));

    let cancelled = false;
    const reveal = () => {
      if (cancelled) return;
      const current = visibleRef.current;
      if (!content.startsWith(current)) { update(content); return; }
      const remaining = content.length - current.length;
      if (remaining <= 0) return;
      const step = remaining > 180 ? 12 : remaining > 90 ? 6 : remaining > 36 ? 3 : 1;
      update(content.slice(0, current.length + step));
      if (visibleRef.current.length < content.length) timerRef.current = window.setTimeout(reveal, 22);
    };
    if (visibleRef.current.length < content.length) timerRef.current = window.setTimeout(reveal, 22);
    return () => {
      cancelled = true;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, [active, content]);

  return visible;
}

function ExecutionActivity({ content, active, dark, conversationId }: { content: string; active: boolean; dark: boolean; conversationId: string }) {
  const visibleContent = useProgressiveText(content, active);
  return <section className="execution-activity" aria-label="执行过程内容" data-streaming={active || undefined}>
    <AIRenderer dark={dark} content={visibleContent} streaming={active} conversationId={conversationId} />
  </section>;
}

export function ToolActivity({ tool, streaming, dark, conversationId, compact = false }: {
  tool: Activity; streaming: boolean; dark: boolean; conversationId: string; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const running = tool.status === "running" && streaming;
  const failed = tool.status === "complete" && tool.isError === true;
  let icon = <Wrench size={14} />;
  let status = "未完成";
  if (running) { icon = <LoaderCircle size={14} className="spin" />; status = "执行中"; }
  else if (failed) { icon = <CircleAlert size={14} className="danger-text" />; status = "失败"; }
  else if (tool.status === "complete") { icon = <Check size={14} />; status = tool.result !== undefined ? "完成" : "已结束"; }

  const resultContent = tool.result === undefined
    ? <p className="tool-empty">{running ? "正在等待工具返回结果…" : "后端未返回结果内容。"}</p>
    : tool.result.length
      ? <ToolOutput content={tool.result} dark={dark} conversationId={conversationId} />
      : <p className="tool-empty">工具返回了空结果。</p>;

  return <details className={`tool-activity ${compact ? "tool-step" : ""}`} data-tool-name={tool.name} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{icon}<span className="tool-name" title={tool.name}>{friendlyToolName(tool.name)}</span>
      <span className={`tool-status${failed ? " danger-text" : ""}`}>{status}</span><ChevronDown size={14} className="tool-chevron" /></summary>
    {open && <div className="tool-details">
      <div className="tool-technical-name">{tool.name}</div>
      {!!tool.arguments && <section aria-label="调用参数"><h3>调用参数</h3><ToolOutput content={tool.arguments} dark={dark} conversationId={conversationId} raw /></section>}
      <section aria-label="执行结果"><h3>执行结果</h3>{resultContent}</section>
    </div>}
  </details>;
}

export function ToolActivityGroup({ tools, activities, activity, streaming, dark, conversationId, startedAt, completedAt }: {
  tools: Activity[]; activities?: TimelineActivity[]; activity?: string; streaming: boolean; dark: boolean;
  conversationId: string; startedAt?: number; completedAt?: number;
}) {
  const [open, setOpen] = useState(streaming);
  const previousStreaming = useRef(streaming);
  const failed = tools.filter((tool) => tool.status === "complete" && tool.isError).length;
  const elapsed = useElapsed(startedAt, completedAt, streaming);
  const expanded = open;
  const title = `${streaming ? "已处理" : "用时"}${elapsed ? ` ${elapsed}` : ""}`;
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const timeline: TimelineActivity[] = [];
  if (activities?.length) {
    for (const item of activities) {
      if (item.type === "reasoning" ? item.content.trim() : toolsById.has(item.toolId)) timeline.push(item);
    }
  } else if (activity) timeline.push({ id: "legacy-reasoning", type: "reasoning", content: activity });
  const timelineToolIds = new Set(timeline.flatMap((item) => item.type === "tool" ? [item.toolId] : []));
  for (const tool of tools) if (!timelineToolIds.has(tool.id)) timeline.push({ id: `legacy-tool-${tool.id}`, type: "tool", toolId: tool.id });
  const activeReasoningId = streaming && timeline.at(-1)?.type === "reasoning" ? timeline.at(-1)?.id : undefined;

  useEffect(() => {
    if (streaming && !previousStreaming.current) setOpen(true);
    if (!streaming && previousStreaming.current) setOpen(false);
    previousStreaming.current = streaming;
  }, [streaming]);

  if (timeline.length === 0) {
    return <div className={`tool-activity-group tool-activity-duration${streaming ? " is-streaming" : ""}`}>
      <span className="tool-group-title" aria-live="polite" aria-atomic="true">{title}</span>
    </div>;
  }

  return <details className={`tool-activity-group${streaming ? " is-streaming" : ""}`} open={expanded} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span className="tool-group-title" aria-live="polite" aria-atomic="true">{title}</span>
      {failed > 0 && <span className="tool-group-status danger-text">{failed} 个失败</span>}
      <ChevronDown size={15} className="tool-chevron" /></summary>
    {(expanded || timeline.length > 0) && <div className="tool-step-list"><div className="execution-timeline" aria-label="执行活动时间线" role="list">
      {timeline.map((item) => <div className={`execution-timeline-item is-${item.type}`} data-activity-id={item.id} data-activity-type={item.type} key={item.id} role="listitem">
        {item.type === "reasoning"
          ? <ExecutionActivity content={item.content} active={item.id === activeReasoningId} dark={dark} conversationId={conversationId} />
          : toolsById.has(item.toolId) && <ToolActivity tool={toolsById.get(item.toolId)!} streaming={streaming} dark={dark} conversationId={conversationId} compact />}
      </div>)}
    </div></div>}
  </details>;
}
