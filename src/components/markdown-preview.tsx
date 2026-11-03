"use client";

import { useSyncExternalStore } from "react";
import { AIRenderer } from "./ai-renderer";

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
const currentTheme = () => document.documentElement.dataset.theme === "dark";

export function MarkdownPreview({ content }: { content: string }) {
  const dark = useSyncExternalStore(subscribeTheme, currentTheme, () => false);
  return <div className="markdown-file-preview ai-content" role="document" aria-label="Markdown 文件内容">
    {content.trim() ? <AIRenderer content={content} dark={dark} /> : <p className="empty-file">（空文件）</p>}
  </div>;
}
