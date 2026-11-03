"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

export function DocxPreview({ buffer, onError }: { buffer: ArrayBuffer; onError: (message: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const channel = useRef("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== ref.current?.contentWindow || data?.source !== "agentcore-docx" || data.channel !== channel.current) return;
      if (data.type === "loaded" && Number.isInteger(data.count) && data.count > 0 && data.count <= 200) {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setCount(data.count);
      }
      if (data.type === "error") {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        onError("Word 文档解析失败，文件可能已损坏、加密或超出预览限制。请下载原文件查看。");
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [onError]);

  const load = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    channel.current = crypto.randomUUID();
    const copy = buffer.slice(0);
    timeoutRef.current = setTimeout(() => onError("Word 文档解析时间过长，请下载原文件查看。"), 30_000);
    ref.current?.contentWindow?.postMessage({ source: "agentcore-host", type: "load", channel: channel.current, buffer: copy }, "*", [copy]);
  };

  return <div className="docx-preview">
    <div className="docx-canvas">
      <iframe ref={ref} src="/api/files/docx-viewer" sandbox="allow-scripts" title="Word 文档预览" onLoad={load} referrerPolicy="no-referrer" />
      {!count && <div className="file-loading-overlay" role="status"><LoaderCircle className="spin" size={23} /><span>正在解析文档…</span></div>}
    </div>
    <div className="document-preview-footer"><span>版式预览，实际效果以原文件为准</span><span aria-live="polite">{count ? `共 ${count} 页` : "正在加载"}</span></div>
  </div>;
}
