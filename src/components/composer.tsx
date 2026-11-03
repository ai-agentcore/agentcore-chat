"use client";

import { useEffect, useRef, type RefObject } from "react";
import { AlertCircle, ArrowUp, File as FileIcon, LoaderCircle, Paperclip, Square, CornerDownLeft, X } from "lucide-react";
import type { PendingAttachment } from "@/lib/types";
import { AttachmentThumbnail } from "./attachment-thumbnail";
import { frontendConfig } from "@/config/frontend";

export function Composer({ value, onChange, onSend, onStop, busy, ready, inputRef, attachments, onFiles, onRemoveAttachment }: {
  value: string; onChange: (value: string) => void; onSend: () => void; onStop: () => void;
  busy: boolean; ready: boolean; inputRef: RefObject<HTMLTextAreaElement | null>;
  attachments: PendingAttachment[]; onFiles: (files: File[]) => void; onRemoveAttachment: (localId: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = attachments.some((item) => item.status !== "ready");
  const hasReadyAttachment = attachments.some((item) => item.status === "ready");
  const canSend = !busy && ready && !pending && (Boolean(value.trim()) || hasReadyAttachment);
  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = "0px"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
  }, [value, inputRef]);

  return (
    <form className="composer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }}>
      {attachments.length > 0 && <div className="composer-attachments" aria-label="待发送附件">{attachments.map((item) => <div className={`composer-attachment attachment-${item.status}`} key={item.localId}>
        {item.previewFile ? <AttachmentThumbnail file={item.previewFile} /> : <span className="composer-attachment-icon">{item.status === "uploading" ? <LoaderCircle className="spin" size={16} /> : item.status === "error" ? <AlertCircle size={16} /> : <FileIcon size={16} />}</span>}
        <span className="composer-attachment-copy"><strong title={item.name}>{item.name}</strong><small aria-live="polite">{item.previewFile && item.status === "uploading" && <LoaderCircle className="spin" size={11} />}{item.status === "uploading" ? "正在上传" : item.status === "error" ? item.error : `${Math.max(1, Math.ceil(item.size / 1024)).toLocaleString()} KB`}</small></span>
        <button type="button" onClick={() => onRemoveAttachment(item.localId)} aria-label={`移除附件：${item.name}`}><X size={15} /></button>
      </div>)}</div>}
      <label className="sr-only" htmlFor="chat-input">向 {frontendConfig.brand.name} 提问</label>
      <textarea id="chat-input" ref={inputRef} value={value} onChange={(event) => onChange(event.target.value)}
        placeholder={`${frontendConfig.copy.composerPlaceholder}（支持粘贴图片）`} rows={1} maxLength={20_000} disabled={!ready}
        onPaste={(event) => {
          if (!ready) return;
          const items = Array.from(event.clipboardData.items || []);
          const images = items.flatMap((item) => {
            if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
            const file = item.getAsFile();
            return file ? [file] : [];
          });
          // Some browsers expose clipboard files without DataTransfer items.
          const files = images.length ? images : Array.from(event.clipboardData.files || []).filter((file) => file.type.startsWith("image/"));
          if (!files.length) return;
          // Preserve native text insertion, including selection/caret behavior,
          // when a clipboard payload contains both text and image files.
          if (!event.clipboardData.getData("text/plain")) event.preventDefault();
          onFiles(files);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-leading">
          <input ref={fileRef} className="sr-only" type="file" multiple onChange={(event) => { onFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
          <button type="button" className="attach-button" disabled={!ready || attachments.length >= 10} onClick={() => fileRef.current?.click()} aria-label="添加文件" title="添加文件（也可粘贴图片，单个不超过 32 MiB）"><Paperclip size={16} /></button>
        </div>
        <div className="composer-actions">
          {value.length > 18_000 ? <span className="input-hint">{value.length.toLocaleString()} / 20,000</span> : <span className="input-hint">Shift + Enter 换行 <CornerDownLeft size={12} /></span>}
          {busy ? <button type="button" className="send-button stop-button" onClick={onStop} aria-label="停止生成" title="停止生成"><Square size={14} fill="currentColor" /></button>
            : <button className="send-button" type="submit" disabled={!canSend} aria-label="发送消息" title="发送消息"><ArrowUp size={21} strokeWidth={2.2} /></button>}
        </div>
      </div>
    </form>
  );
}
