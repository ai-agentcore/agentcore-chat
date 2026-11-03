"use client";

import { memo, useState } from "react";
import { Check, Copy, RotateCcw, AlertCircle, File } from "lucide-react";
import { AIRenderer } from "./ai-renderer";
import { ToolActivityGroup } from "./tool-activity";
import type { ChatMessage } from "@/lib/types";
import { restorePublishedArtifactLinks } from "@/lib/agent-stream";
import { frontendConfig } from "@/config/frontend";

export const Message = memo(function Message({ message, conversationId, canRegenerate, onRegenerate, onNotice, dark }: {
  message: ChatMessage; canRegenerate: boolean; onRegenerate: () => void; onNotice: (value: string) => void;
  conversationId: string; dark: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (message.role === "user") return <article className="message user-message" data-message-id={message.id} aria-label="你的消息"><div className="user-bubble">
    {!!message.attachments?.length && <div className="message-attachments">{message.attachments.map((attachment) => <div className="message-attachment" key={attachment.id}><File size={15} /><span><strong>{attachment.name}</strong><small>{Math.max(1, Math.ceil(attachment.size / 1024)).toLocaleString()} KB</small></span></div>)}</div>}
    {message.content && <div>{message.content}</div>}
  </div></article>;

  const streaming = message.status === "streaming";
  const content = restorePublishedArtifactLinks(message.content, message.tools);
  const tools = message.tools ?? [];
  const showRunSummary = streaming || Boolean(message.startedAt || message.completedAt || message.reasoning || tools.length);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { onNotice("复制失败，请选中文字后手动复制。"); }
  };

  return (
    <article className={`message assistant-message ${streaming ? "is-streaming" : ""}`} data-message-id={message.id} aria-label={`${frontendConfig.brand.name} 的回复`} aria-busy={streaming}>
      {showRunSummary && <div className="tool-activities"><ToolActivityGroup tools={tools} activities={message.runActivities} activity={message.reasoning} streaming={streaming} dark={dark} conversationId={conversationId} startedAt={message.startedAt} completedAt={message.completedAt} /></div>}
      {content ? <div className="ai-content" data-testid="ai-content"><AIRenderer dark={dark} content={content} streaming={streaming} conversationId={conversationId} /></div>
        : null}
      {message.status === "error" && <div className="message-error" role="alert"><AlertCircle size={16} /><span>{message.error}</span></div>}
      {message.status === "stopped" && <div className="stopped-label">已停止生成</div>}
      {!streaming && <div className="message-actions">
        {!!content && <button className="icon-button" onClick={copy} aria-label={copied ? "已复制" : "复制回复"} title={copied ? "已复制" : "复制回复"}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>}
        {canRegenerate && <button className={message.status === "error" ? "retry-button" : "icon-button"} onClick={onRegenerate} aria-label="重新生成" title="重新生成"><RotateCcw size={16} />{message.status === "error" && <span>重试</span>}</button>}
      </div>}
    </article>
  );
});
