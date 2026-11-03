"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Download, ImageIcon, LoaderCircle, RotateCcw, ZoomIn } from "lucide-react";
import { describeFile, fileApiUrl, formatFileSize, MAX_PREVIEW_BYTES, type FileMetadata } from "@/lib/files";
import { Dialog } from "./dialog";

type ImageState =
  | { status: "loading" }
  | { status: "ready"; url: string; metadata: FileMetadata }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

async function checked(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.error === "string" ? body.error : "图片读取失败，请稍后重试。");
  }
  return response;
}

/** Receives only a normalized mount path from FileCard, never a model-supplied URL. */
export function ImageArtifact({ path, name, conversationId }: { path: string; name: string; conversationId?: string }) {
  const [state, setState] = useState<ImageState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const file = describeFile(name);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    let active = true;
    let objectUrl = "";
    const load = async () => {
      try {
        const metadata = await (await checked(await fetch(fileApiUrl(path, "metadata", conversationId), { signal: controller.signal, cache: "no-store" }))).json() as FileMetadata;
        if (!active) return;
        if (metadata.kind !== "image" || !metadata.previewable || metadata.size > MAX_PREVIEW_BYTES) {
          setState({ status: "unavailable", message: metadata.size > MAX_PREVIEW_BYTES ? "图片较大，请下载原文件查看。" : "这张图片暂不支持在线预览，请下载查看。" });
          return;
        }
        if (metadata.extension === "svg") {
          // Keep SVG on the authenticated same-origin response so its strict
          // sandbox/default-src CSP remains attached to the image document.
          setState({ status: "ready", url: fileApiUrl(path, "content", conversationId), metadata });
          return;
        }
        const response = await checked(await fetch(fileApiUrl(path, "content", conversationId), { signal: controller.signal, cache: "no-store" }));
        const bytes = await response.arrayBuffer();
        if (!active) return;
        if (bytes.byteLength > MAX_PREVIEW_BYTES) throw new Error("图片较大，请下载原文件查看。");
        // Keep both the MIME type and URL under application control.
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: metadata.contentType }));
        setState({ status: "ready", url: objectUrl, metadata });
      } catch (cause) {
        if (active) setState({ status: "error", message: controller.signal.aborted ? "读取图片超时，请重试。" : cause instanceof Error ? cause.message : "图片读取失败。" });
      } finally { clearTimeout(timeout); }
    };
    void load();
    return () => { active = false; clearTimeout(timeout); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, conversationId, attempt]);

  const retry = () => { setState({ status: "loading" }); setAttempt((value) => value + 1); };
  const decodeError = () => { setOpen(false); setState({ status: "error", message: "图片格式无法识别，请重试或下载原文件查看。" }); };
  const download = <a className="image-artifact-download" href={fileApiUrl(path, "download", conversationId)} download={file.name} aria-label={`下载图片：${name}`} title="下载原图"><Download size={17} /></a>;

  return <>
    <figure className="image-artifact" aria-label={`图片文件：${name}`}>
      {state.status === "ready" ? <button className="image-artifact-preview" onClick={() => setOpen(true)} aria-label={`预览文件：${name}`}>
        {/* Authenticated file bytes, not a remote image optimizer or public OSS URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.url} alt={name} onError={decodeError} />
        <span className="image-artifact-zoom" aria-hidden="true"><ZoomIn size={16} /></span>
      </button> : <div className="image-artifact-state" role={state.status === "error" ? "alert" : "status"}>
        {state.status === "loading" ? <><LoaderCircle className="spin" size={22} /><span>正在读取图片…</span></> : <>
          {state.status === "error" ? <AlertCircle size={22} /> : <ImageIcon size={22} />}<span>{state.message}</span>
          {state.status === "error" && <button className="secondary-button" onClick={retry}><RotateCcw size={14} />重试</button>}
        </>}
      </div>}
      <figcaption className="image-artifact-caption">
        <span className="file-card-info"><strong title={file.name}>{name}</strong><span>{file.extension.toUpperCase()}{state.status === "ready" && <><span className="file-card-dot">·</span>{formatFileSize(state.metadata.size)}<span className="file-card-dot">·</span>点击放大</>}</span></span>
        {download}
      </figcaption>
    </figure>
    {open && state.status === "ready" && <Dialog open onClose={() => setOpen(false)} title={name} className="file-preview-dialog">
      <div className="file-preview-meta"><span className="file-preview-details">{file.extension.toUpperCase()} · {formatFileSize(state.metadata.size)}</span><a className="file-download-button" href={fileApiUrl(path, "download", conversationId)} download={file.name}><Download size={15} />下载原文件</a></div>
      <div className="file-preview-body"><div className="image-preview">
        {/* Reuse the loaded blob when enlarging; do not fetch or issue STS again. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.url} alt={name} onError={decodeError} />
      </div></div>
    </Dialog>}
  </>;
}
