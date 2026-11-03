"use client";

import { useEffect, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";

/** Local draft preview only; image bytes and blob URLs never enter chat history. */
export function AttachmentThumbnail({ file }: { file: File }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const url = URL.createObjectURL(file);
    image.src = url;
    return () => { image.removeAttribute("src"); URL.revokeObjectURL(url); };
  }, [file]);

  return <span className="attachment-thumbnail">
    {failed ? <ImageIcon size={24} aria-label="图片缩略图不可用" /> :
      // The source is a local File chosen or pasted by the user, not an external URL.
      // eslint-disable-next-line @next/next/no-img-element
      <img ref={imageRef} alt={`待发送图片：${file.name}`} onError={() => setFailed(true)} />}
  </span>;
}
