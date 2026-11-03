"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { ChatMessage } from "@/lib/types";
import { frontendConfig } from "@/config/frontend";

const MIN_MESSAGE_COUNT = 2;
const MIN_OVERFLOW = 180;
const NAVIGATION_DURATION_MS = 140;

function compactPreview(message: ChatMessage) {
  const text = message.content || message.reasoning || message.error
    || message.attachments?.map((attachment) => attachment.name).join("、")
    || message.tools?.map((tool) => tool.name).join("、")
    || (message.status === "streaming" ? "正在处理…" : "这条消息暂无文字内容");
  return text.replace(/[`#>*_~\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function messageElements(scroller: HTMLDivElement) {
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-message-id]"));
}

export function ConversationMinimap({ messages, scrollRef }: { messages: ChatMessage[]; scrollRef: RefObject<HTMLDivElement | null> }) {
  const [activeId, setActiveId] = useState(messages[0]?.id ?? "");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const navigationFrame = useRef(0);
  const previews = useMemo(() => new Map(messages.map((message) => [message.id, compactPreview(message)])), [messages]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const items = messageElements(scroller);
        setVisible(messages.length >= MIN_MESSAGE_COUNT && scroller.scrollHeight - scroller.clientHeight >= MIN_OVERFLOW);
        if (!items.length) return;
        const viewport = scroller.getBoundingClientRect();
        const readingLine = viewport.top + Math.min(viewport.height * .3, 240);
        let nearest = items[0];
        let distance = Number.POSITIVE_INFINITY;
        for (const item of items) {
          const rect = item.getBoundingClientRect();
          const next = rect.top <= readingLine && rect.bottom >= readingLine ? 0 : Math.min(Math.abs(rect.top - readingLine), Math.abs(rect.bottom - readingLine));
          if (next < distance) { nearest = item; distance = next; }
        }
        setActiveId(nearest.dataset.messageId ?? messages[0]?.id ?? "");
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    const content = scroller.querySelector<HTMLElement>(".messages");
    if (content) observer.observe(content);
    scroller.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(navigationFrame.current);
      observer.disconnect();
      scroller.removeEventListener("scroll", update);
    };
  }, [messages, scrollRef]);

  if (!visible) return null;
  const previewIndex = messages.findIndex((message) => message.id === previewId);
  const jumpTo = (messageId: string) => {
    const scroller = scrollRef.current;
    const target = scroller && messageElements(scroller).find((item) => item.dataset.messageId === messageId);
    if (!scroller || !target) return;
    const start = scroller.scrollTop;
    const destination = Math.max(0, start + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 18);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { scroller.scrollTo({ top: destination }); return; }
    cancelAnimationFrame(navigationFrame.current);
    let startedAt: number | null = null;
    const animate = (now: number) => {
      startedAt ??= now;
      const progress = Math.min(1, (now - startedAt) / NAVIGATION_DURATION_MS);
      scroller.scrollTop = start + (destination - start) * (1 - Math.pow(1 - progress, 3));
      if (progress < 1) navigationFrame.current = requestAnimationFrame(animate);
    };
    navigationFrame.current = requestAnimationFrame(animate);
  };

  return <nav className="conversation-minimap" aria-label="对话快速导航"><div className="conversation-minimap-track" style={{ "--minimap-items": messages.length } as CSSProperties}>
    {messages.map((message, index) => {
      const active = message.id === activeId;
      const hoverDistance = previewIndex < 0 ? -1 : Math.abs(index - previewIndex);
      const hoverClass = hoverDistance === 0 ? "hovered" : hoverDistance === 1 ? "hover-near-1" : hoverDistance === 2 ? "hover-near-2" : "";
      const roleLabel = message.role === "user" ? "你的消息" : `${frontendConfig.brand.name} 回复`;
      const preview = previews.get(message.id) || "这条消息暂无文字内容";
      return <div className="conversation-minimap-item" key={message.id}>
        <button type="button" className={`conversation-minimap-tick ${active ? "active" : ""} ${hoverClass}`} aria-label={`跳到${roleLabel}：${preview}`} aria-current={active ? "location" : undefined}
          onClick={() => jumpTo(message.id)} onMouseEnter={() => setPreviewId(message.id)} onMouseLeave={() => setPreviewId(null)} onFocus={() => setPreviewId(message.id)} onBlur={() => setPreviewId(null)} />
        {message.id === previewId && <div className="conversation-minimap-preview" role="tooltip"><strong>{roleLabel}</strong><span>{preview}</span></div>}
      </div>;
    })}
  </div></nav>;
}
