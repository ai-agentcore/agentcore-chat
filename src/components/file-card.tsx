"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { ArrowUpRight, FileText, FileImage, File, Presentation, FileCode2, FileVideo2 } from "lucide-react";
import { describeFile, normalizeFileReference, type PreviewKind } from "@/lib/files";
import { ImageArtifact } from "./image-artifact";
import { useFileConversation } from "./file-conversation-context";

const FilePreview = dynamic(() => import("./file-preview").then((module) => module.FilePreview), { ssr: false });

export function FileIcon({ kind, size = 24 }: { kind: PreviewKind; size?: number }) {
  const Icon = kind === "pptx" ? Presentation : kind === "image" ? FileImage : kind === "video" ? FileVideo2 : kind === "text" ? FileCode2 : ["pdf", "docx", "markdown"].includes(kind) ? FileText : File;
  return <Icon size={size} strokeWidth={1.5} />;
}

export function FileCard({ filePath, fileName }: { filePath?: unknown; fileName?: unknown }) {
  const [open, setOpen] = useState(false);
  const conversationId = useFileConversation();
  let path: string;
  let name: string;
  try {
    if (typeof filePath !== "string") return null;
    path = normalizeFileReference(decodeURIComponent(filePath));
    name = typeof fileName === "string" ? decodeURIComponent(fileName).slice(0, 160) : describeFile(path).name;
  } catch { return <span className="invalid-file">文件路径无效</span>; }
  const file = describeFile(name);
  if (file.kind === "image") return <ImageArtifact key={path} path={path} name={name} conversationId={conversationId} />;
  return <>
    <button className={`file-card file-kind-${file.kind}`} onClick={() => setOpen(true)} aria-label={`预览文件：${name}`}>
      <span className="file-card-icon"><FileIcon kind={file.kind} /></span>
      <span className="file-card-info"><strong>{name}</strong><span>{file.extension.toUpperCase() || "文件"}<span className="file-card-dot">·</span>{file.kind === "unsupported" ? "查看文件" : "点击预览"}</span></span>
      <ArrowUpRight className="file-card-arrow" size={17} />
    </button>
    {open && <FilePreview path={path} name={name} conversationId={conversationId} onClose={() => setOpen(false)} />}
  </>;
}
