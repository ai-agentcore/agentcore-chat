"use client";

import dynamic from "next/dynamic";
import { Children, isValidElement, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { artifactRenderKey, prepareArtifactContent } from "@/lib/artifact-content";
import { FileCard } from "./file-card";
import { FileConversationContext, useFileConversation } from "./file-conversation-context";

const ReactAIRenderer = dynamic(() => import("react-ai-renderer").then((module) => module.default), {
  ssr: false,
  loading: () => <span className="renderer-loading">正在准备内容…</span>,
});

type CodeProps = { children?: ReactNode; className?: string };

function plainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  return isValidElement<CodeProps>(node) ? plainText(node.props.children) : "";
}

function CodeBlock({ children }: CodeProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const code = Children.toArray(children).find((child) => isValidElement<CodeProps>(child));
  const language = isValidElement<CodeProps>(code) ? /language-([\w+-]+)/.exec(code.props.className || "")?.[1] : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText(children).replace(/\n$/, ""));
      setCopied(true); setFailed(false);
      setTimeout(() => setCopied(false), 1800);
    } catch { setFailed(true); }
  };
  return <div className="code-block"><div className="code-header"><span>{language || "代码"}</span><button onClick={copy} aria-label="复制代码">{copied ? <Check size={13} /> : <Copy size={13} />}<span>{failed ? "请手动复制" : copied ? "已复制" : "复制代码"}</span></button></div><pre>{children}</pre></div>;
}

function Code({ children, className }: CodeProps) {
  return <code className={className}>{children}</code>;
}

// Markdown remains rendered by react-ai-renderer, including its highlight/math plugins.
// Streamable overrides render only known props and do not evaluate model-authored JSX.
const components = {
  pre: { value: CodeBlock, streamable: true },
  code: { value: Code, streamable: true },
  // A distinct internal name keeps literal <FileCard> examples in code blocks
  // out of the library's component parser, which runs before Markdown parsing.
  AgentFileArtifact: { value: FileCard, streamable: true, selfClosing: true },
};

export function AIRenderer({ content, dark, streaming = false, conversationId }: { content: string; dark: boolean; streaming?: boolean; conversationId?: string }) {
  const inheritedConversation = useFileConversation();
  const preparedContent = prepareArtifactContent(content, streaming);
  const rendererKey = artifactRenderKey(preparedContent);
  return <FileConversationContext.Provider value={conversationId || inheritedConversation}>
    <ReactAIRenderer key={rendererKey} components={components} useGithubStyles={false} theme={dark ? "dark" : "light"}>{preparedContent}</ReactAIRenderer>
  </FileConversationContext.Provider>;
}
