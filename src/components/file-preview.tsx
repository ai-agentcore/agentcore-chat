"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Download, LoaderCircle, RotateCcw } from "lucide-react";
import { fileApiUrl, formatFileSize, type FileMetadata } from "@/lib/files";
import { Dialog } from "./dialog";
import { FileIcon } from "./file-card";
import { PptxPreview } from "./pptx-preview";
import { DocxPreview } from "./docx-preview";
import { MarkdownPreview } from "./markdown-preview";

async function checked(response: Response) {
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(typeof error?.error === "string" ? error.error : "无法读取文件，请稍后重试。");
  }
  return response;
}

export function FilePreview({ path, name, conversationId, onClose }: { path: string; name: string; conversationId?: string; onClose: () => void }) {
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const previewError = useCallback((message: string) => setError(message), []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("读取文件超时，请重试。")), 90_000);
    let objectUrl = "";
    let active = true;
    const load = async () => {
      try {
        const info = await (await checked(await fetch(fileApiUrl(path, "metadata", conversationId), { signal: controller.signal, cache: "no-store" }))).json() as FileMetadata;
        if (!active) return;
        setMetadata(info);
        if (info.previewable) {
          if (info.kind === "video") {
            setUrl(fileApiUrl(path, "content", conversationId));
            setLoading(false);
            return;
          }
          const result = await checked(await fetch(fileApiUrl(path, "content", conversationId), { signal: controller.signal, cache: "no-store" }));
          const bytes = await result.arrayBuffer();
          if (!active) return;
          if (bytes.byteLength > info.previewLimit) throw new Error("文件较大，请下载原文件查看。");
          if (info.kind === "text" || info.kind === "markdown") setText(new TextDecoder().decode(bytes));
          else if (info.kind === "pptx" || info.kind === "docx") setBuffer(bytes);
          else { objectUrl = URL.createObjectURL(new Blob([bytes], { type: info.contentType })); setUrl(objectUrl); }
        }
        setLoading(false);
      } catch (cause) {
        if (!active) return;
        setError(controller.signal.aborted ? "读取文件超时，请重试。" : cause instanceof Error ? cause.message : "文件读取失败。");
        setLoading(false);
      } finally { clearTimeout(timeout); }
    };
    void load();
    return () => { active = false; clearTimeout(timeout); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, conversationId, attempt]);

  const retry = () => { setError(""); setLoading(true); setBuffer(null); setUrl(""); setText(""); setMetadata(null); setAttempt((value) => value + 1); };

  return <Dialog open onClose={onClose} title={name} className="file-preview-dialog">
    <div className="file-preview-meta"><div className="file-preview-details">{metadata && <><FileIcon kind={metadata.kind} size={17} /><span>{metadata.extension.toUpperCase() || "文件"}</span><span>·</span><span>{formatFileSize(metadata.size)}</span></>}</div>{metadata && <a className="file-download-button" href={fileApiUrl(path, "download", conversationId)} download={metadata.name}><Download size={15} /><span>下载原文件</span></a>}</div>
    <div className="file-preview-body">
      {loading ? <div className="file-preview-state" role="status"><LoaderCircle className="spin" size={25} /><h3>正在读取文件</h3><p>正在准备预览，请稍候。</p></div>
        : error ? <div className="file-preview-state file-preview-error" role="alert"><AlertCircle size={28} /><h3>暂时无法预览</h3><p>{error}</p><button className="secondary-button" onClick={retry}><RotateCcw size={14} />重试</button></div>
        : metadata && !metadata.previewable ? <div className="file-preview-state"><FileIcon kind={metadata.kind} size={37} /><h3>{metadata.size > metadata.previewLimit ? "文件较大，请下载查看" : "此格式暂不支持在线预览"}</h3><p>{metadata.size > metadata.previewLimit ? `在线预览上限为 ${formatFileSize(metadata.previewLimit)}，原文件可完整下载。` : metadata.extension === "doc" ? "旧版 DOC 请另存为 DOCX 后预览，也可以下载原文件查看。" : "可以下载原文件，使用对应的应用打开。"}</p><a className="primary-button" href={fileApiUrl(path, "download", conversationId)} download={metadata.name}><Download size={15} />下载原文件</a></div>
        : metadata?.kind === "pptx" && buffer ? <PptxPreview key={attempt} buffer={buffer} onError={previewError} />
        : metadata?.kind === "docx" && buffer ? <DocxPreview key={attempt} buffer={buffer} onError={previewError} />
        : metadata?.kind === "markdown" ? <MarkdownPreview content={text} />
        : metadata?.kind === "pdf" && url ? <iframe className="pdf-preview" src={url} title={`${name} PDF 预览`} />
        : metadata?.kind === "video" && url ? <div className="video-preview">
          <video key={attempt} controls playsInline preload="metadata" onError={() => setError("视频格式无法播放，请下载原文件查看。")}>
            <source src={url} type={metadata.contentType} />
            当前浏览器不支持视频播放，请下载原文件查看。
          </video>
        </div>
        : metadata?.kind === "image" && url ? <div className="image-preview">
          {/* The source is a temporary blob URL created after the file proxy responds. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={name} onError={() => setError("图片格式无法识别，请下载原文件查看。")} />
        </div>
        : metadata?.kind === "text" ? <pre className="text-file-preview" aria-label="文件内容">{text || "（空文件）"}</pre> : null}
    </div>
  </Dialog>;
}
