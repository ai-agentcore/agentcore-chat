"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";

export function PptxPreview({ buffer, onError }: { buffer: ArrayBuffer; onError: (message: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const channel = useRef("");
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== ref.current?.contentWindow || data?.source !== "agentcore-pptx" || data.channel !== channel.current) return;
      const validCount = Number.isInteger(data.count) && data.count > 0 && data.count <= 200;
      if (data.type === "loaded" && validCount) { if (timeoutRef.current) clearTimeout(timeoutRef.current); setLoaded(true); setCount(data.count); }
      if (data.type === "page" && validCount && Number.isInteger(data.index) && data.index >= 0 && data.index < data.count) { setIndex(data.index); setCount(data.count); }
      if (data.type === "error") { if (timeoutRef.current) clearTimeout(timeoutRef.current); onError("PPTX 解析失败，请下载原文件查看。"); }
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [onError]);

  const load = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    channel.current = crypto.randomUUID();
    // Keep the original buffer for remounts; transfer a copy to the isolated frame.
    const copy = buffer.slice(0);
    ref.current?.contentWindow?.postMessage({ source: "agentcore-host", type: "load", channel: channel.current, buffer: copy }, "*", [copy]);
    timeoutRef.current = setTimeout(() => onError("PPTX 解析时间过长，请下载原文件查看。"), 30_000);
  };
  const page = (next: number) => ref.current?.contentWindow?.postMessage({ source: "agentcore-host", type: "page", channel: channel.current, index: next }, "*");

  return <div className="pptx-preview">
    <div className="pptx-canvas"><iframe ref={ref} src="/api/files/pptx-viewer" sandbox="allow-scripts" title="PPTX 幻灯片预览" onLoad={load} referrerPolicy="no-referrer" />{!loaded && <div className="file-loading-overlay"><LoaderCircle className="spin" size={23} /><span>正在解析幻灯片…</span></div>}</div>
    <div className="pptx-toolbar"><span className="pptx-note">版式预览，实际效果以原文件为准</span><div className="pptx-pagination"><button className="icon-button" aria-label="上一页幻灯片" disabled={index === 0 || !loaded} onClick={() => page(index - 1)}><ChevronLeft size={18} /></button><span aria-live="polite">{loaded ? `${index + 1} / ${count}` : "— / —"}</span><button className="icon-button" aria-label="下一页幻灯片" disabled={!loaded || index >= count - 1} onClick={() => page(index + 1)}><ChevronRight size={18} /></button></div></div>
  </div>;
}
