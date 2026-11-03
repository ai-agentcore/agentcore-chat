"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { ArrowDown, ArrowUpRight, Check, Code2, Download, FolderInput, Lightbulb, MessageCircle, PanelLeft, PenLine, Pin, PinOff, Search, ShieldCheck, Sparkles, X, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useChat } from "@/hooks/use-chat";
import type { Conversation, PendingAttachment } from "@/lib/types";
import { frontendConfig, type ScenarioCategory } from "@/config/frontend";
import { BrandMark } from "./brand";
import { Sidebar } from "./sidebar";
import { Composer } from "./composer";
import { Message } from "./message";
import { Dialog } from "./dialog";
import { AccountDialog } from "./account-dialog";
import { ConversationMinimap } from "./conversation-minimap";
import type { CurrentUser } from "@/lib/user-profile";
import { authClient, reloadAfterAuth } from "@/lib/auth-client";
import { uploadAttachment } from "@/lib/upload-client";

const scenarioIcons: Record<ScenarioCategory["icon"], ComponentType<{ size?: number; className?: string; strokeWidth?: number }>> = {
  write: PenLine, idea: Lightbulb, code: Code2, chat: MessageCircle,
};

export function ChatApp({ user }: { user: CurrentUser }) {
  const chat = useChat(user.id);
  const [accountOpen, setAccountOpen] = useState(false);
  useEffect(() => {
    const check = async () => {
      try {
        const result = await authClient.getSession();
        if (!result.error && result.data?.user.id && result.data.user.id !== user.id) reloadAfterAuth("/");
      } catch { /* Keep the draft on transient network failure. */ }
    };
    window.addEventListener("focus", check);
    const timer = setInterval(check, 60_000);
    return () => { window.removeEventListener("focus", check); clearInterval(timer); };
  }, [user.id]);
  const { newChat: createNewChat } = chat;
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [dark, setDark] = useState(frontendConfig.theme.defaultMode === "dark");
  const [searchOpen, setSearchOpen] = useState(false);
  const [scenarioCategoryId, setScenarioCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [editChat, setEditChat] = useState<Conversation | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [projectChat, setProjectChat] = useState<Conversation | null>(null);
  const [projectName, setProjectName] = useState("");
  const [deletingChat, setDeletingChat] = useState<Conversation | null>(null);
  const [showScroll, setShowScroll] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const stickyRef = useRef(true);
  const empty = !chat.active?.messages.length;

  useEffect(() => {
    let live = true;
    fetch("/api/chat").then((response) => response.json()).then((data) => { if (live) setConfigured(Boolean(data.configured)); }).catch(() => {});
    queueMicrotask(() => {
      try {
        if (live) {
          const stored = localStorage.getItem("agentcore-chat:theme");
          const selected = stored === "dark" || stored === "light" ? stored : frontendConfig.theme.defaultMode;
          setDark(selected === "dark");
          document.documentElement.dataset.theme = selected;
        }
      } catch { /* The configured default theme works without browser storage. */ }
    });
    return () => { live = false; };
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try { localStorage.setItem("agentcore-chat:theme", next ? "dark" : "light"); } catch { /* Optional preference. */ }
  };

  const newChat = useCallback(() => {
    createNewChat(); setDraft(""); setAttachments([]); setMobileSidebar(false); setShowScroll(false); stickyRef.current = true;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [createNewChat]);

  const selectChat = (id: string) => {
    chat.selectChat(id); setDraft(""); setAttachments([]); setMobileSidebar(false); setSearchOpen(false); setShowScroll(false); stickyRef.current = true;
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(false); newChat(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); setSearchOpen(true); setQuery(""); }
      if (event.key === "Escape") setMobileSidebar(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [newChat]);

  useEffect(() => {
    if (stickyRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat.active?.messages, chat.active?.id]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const messages = scroller?.firstElementChild;
    if (!scroller || !messages) return;
    const observer = new ResizeObserver(() => { if (stickyRef.current) scroller.scrollTop = scroller.scrollHeight; });
    observer.observe(messages);
    return () => observer.disconnect();
  }, [empty]);

  useEffect(() => {
    if (!mobileSidebar) return;
    const sidebar = sidebarRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(sidebar?.querySelectorAll<HTMLElement>("a[href], button, summary") || []).filter((element) => element.offsetParent !== null);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); previous?.focus(); };
  }, [mobileSidebar]);

  const send = () => {
    const readyAttachments = attachments.flatMap((item) => item.status === "ready" && item.attachment ? [item.attachment] : []);
    if ((!draft.trim() && !readyAttachments.length) || attachments.some((item) => item.status !== "ready") || chat.busy || !chat.ready) return;
    stickyRef.current = true;
    chat.send(draft, readyAttachments); setDraft(""); setAttachments([]);
    inputRef.current?.focus();
  };

  const addFiles = (files: File[]) => {
    const available = Math.max(0, 10 - attachments.length);
    if (files.length > available) chat.setNotice("每条消息最多添加 10 个文件。");
    for (const file of files.slice(0, available)) {
      const localId = crypto.randomUUID();
      const validSize = file.size > 0 && file.size <= 32 * 1024 * 1024;
      const item: PendingAttachment = { localId, name: file.name, size: file.size, status: "uploading", ...(validSize && file.type.startsWith("image/") ? { previewFile: file } : {}) };
      setAttachments((previous) => [...previous, item]);
      if (!validSize) {
        setAttachments((previous) => previous.map((value) => value.localId === localId ? { ...value, status: "error", error: "文件必须小于 32 MiB" } : value));
        continue;
      }
      void uploadAttachment(chat.threadId, file, user.id).then((attachment) => {
        setAttachments((previous) => previous.map((value) => value.localId === localId ? { ...value, status: "ready", attachment } : value));
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "上传失败，请重试";
        setAttachments((previous) => previous.map((value) => value.localId === localId ? { ...value, status: "error", error: message } : value));
      });
    }
  };

  const rename = (conversation: Conversation) => { setEditChat(conversation); setEditTitle(conversation.title); };
  const organizeInProject = (conversation: Conversation) => { setProjectChat(conversation); setProjectName(conversation.project ?? ""); };
  const exportChat = () => {
    if (!chat.active) return;
    const markdown = `# ${chat.active.title}\n\n` + chat.active.messages.map((message) => `## ${message.role === "user" ? "你" : frontendConfig.brand.name}\n\n${message.content}${message.status === "stopped" ? "\n\n（已停止生成）" : ""}`).join("\n\n---\n\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${chat.active.title.replace(/[\\/:*?"<>|]/g, "-")}.md`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const filteredChats = chat.conversations.filter((conversation) => {
    const term = query.trim().toLowerCase();
    return conversation.title.toLowerCase().includes(term) || conversation.messages.some((message) => message.content.toLowerCase().includes(term));
  });
  const projectNames = Array.from(new Set(chat.conversations.flatMap((conversation) => conversation.project ? [conversation.project] : [])));
  const scenarioCategory = frontendConfig.copy.scenarios.find((category) => category.id === scenarioCategoryId);
  const selectScenario = (prompt: string) => { setDraft(prompt); setScenarioCategoryId(null); requestAnimationFrame(() => inputRef.current?.focus()); };

  return <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${mobileSidebar ? "mobile-sidebar-open" : ""}`}>
    <a className="skip-link" href="#chat-input">跳到消息输入框</a>
    {mobileSidebar && <div className="sidebar-backdrop" onClick={() => setMobileSidebar(false)} aria-hidden="true" />}
    <aside ref={sidebarRef} className="sidebar" aria-label="会话侧栏" role={mobileSidebar ? "dialog" : undefined} aria-modal={mobileSidebar || undefined}>
      <Sidebar conversations={chat.conversations} activeId={chat.active?.id} onNew={newChat} onSearch={() => { setSearchOpen(true); setQuery(""); setMobileSidebar(false); }} onSelect={selectChat}
        onClose={() => { setSidebarOpen(false); setMobileSidebar(false); }} onRename={rename} onDelete={setDeletingChat} onTogglePin={(conversation) => chat.togglePinChat(conversation.id)} onProject={organizeInProject}
        dark={dark} onTheme={toggleTheme} user={user} onAccount={() => { setAccountOpen(true); setMobileSidebar(false); }} />
    </aside>

    <main className="main-panel" inert={mobileSidebar ? true : undefined}>
      <header className="main-header"><div className="header-leading">
        <button ref={mobileToggleRef} className="icon-button sidebar-toggle" onClick={() => { if (window.matchMedia("(max-width: 767px)").matches) setMobileSidebar(true); else setSidebarOpen(true); }} aria-label="展开侧栏" title="展开侧栏"><PanelLeft size={21} /></button>
      </div><div className="header-actions">
        {chat.active ? <>
          <button className="export-button" onClick={exportChat}><Download size={15} /><span>导出对话</span></button>
          <details className="chat-menu"><summary className="icon-button" aria-label="当前对话选项"><MoreHorizontal size={21} /></summary><div className="history-popover">
            <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); chat.togglePinChat(chat.active!.id); }}>{chat.active.pinned ? <PinOff size={15} /> : <Pin size={15} />}{chat.active.pinned ? "取消置顶" : "置顶对话"}</button>
            <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); organizeInProject(chat.active!); }}><FolderInput size={15} />{chat.active.project ? "更换项目" : "加入项目"}</button>
            <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); rename(chat.active!); }}><Pencil size={15} />重命名</button>
            <button className="danger-text" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setDeletingChat(chat.active); }}><Trash2 size={15} />删除对话</button>
          </div></details>
        </> : <div className="private-label"><ShieldCheck size={14} strokeWidth={1.7} /><span>历史仅存于此浏览器</span></div>}
      </div></header>

      {chat.notice && <div className="notice" role="status"><span>{chat.notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => chat.setNotice(null)}><X size={15} /></button></div>}

      {empty ? <div className="welcome-view"><div className="welcome-content">
        <div className="welcome-emblem"><BrandMark size={43} /></div>
        <h1>{frontendConfig.copy.welcomeTitle}</h1><p className="welcome-subtitle">{frontendConfig.copy.welcomeSubtitle}</p>
        <Composer value={draft} onChange={setDraft} onSend={send} onStop={chat.stop} busy={chat.busy} ready={chat.ready} inputRef={inputRef} attachments={attachments} onFiles={addFiles} onRemoveAttachment={(id) => setAttachments((items) => items.filter((item) => item.localId !== id))} />
        <div className="suggestions" aria-label="任务场景">{frontendConfig.copy.scenarios.map(({ id, label, icon, tone }) => {
          const Icon = scenarioIcons[icon];
          return <button key={id} type="button" aria-haspopup="dialog" onClick={() => setScenarioCategoryId(id)} className="suggestion"><Icon size={16} className={`suggestion-icon ${tone}`} strokeWidth={1.7} /><span>{label}</span><ArrowUpRight className="suggestion-arrow" size={13} /></button>;
        })}</div>
      </div><div className="welcome-bottom"><span className="status-dot" /><span>{frontendConfig.copy.welcomeFootnote}</span></div></div> : <>
        <div className="messages-scroll" ref={scrollRef} onScroll={(event) => {
          const element = event.currentTarget; const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
          stickyRef.current = nearBottom; setShowScroll(!nearBottom);
        }}><div className="messages" aria-label="对话消息">{chat.active!.messages.map((message, index) => <Message key={message.id} message={message} conversationId={chat.active!.id} dark={dark} canRegenerate={!chat.busy && index === chat.active!.messages.length - 1} onRegenerate={() => { stickyRef.current = true; chat.regenerate(); }} onNotice={chat.setNotice} />)}<div className="conversation-end" /></div></div>
        <ConversationMinimap messages={chat.active!.messages} scrollRef={scrollRef} />
        <div className="chat-bottom">{showScroll && <button className="scroll-bottom" aria-label="滚动到底部" onClick={() => { stickyRef.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}><ArrowDown size={18} /></button>}
          <div className="composer-container"><Composer value={draft} onChange={setDraft} onSend={send} onStop={chat.stop} busy={chat.busy} ready={chat.ready} inputRef={inputRef} attachments={attachments} onFiles={addFiles} onRemoveAttachment={(id) => setAttachments((items) => items.filter((item) => item.localId !== id))} /></div>
        </div>
      </>}

      <footer className="main-footer">{frontendConfig.copy.footerDisclaimer}<span className="footer-divider">·</span><button onClick={() => setInfoOpen(true)}>关于 {frontendConfig.brand.name}</button></footer>
      <div className="sr-only" role="status" aria-live="polite">{chat.busy ? `${frontendConfig.brand.name} 正在生成回复` : chat.active ? "回复已结束，可以继续对话" : "准备就绪"}</div>
    </main>

    <AccountDialog user={user} open={accountOpen} onClose={() => setAccountOpen(false)} onBeforeSignOut={chat.stop} />
    <Dialog open={Boolean(scenarioCategory)} onClose={() => setScenarioCategoryId(null)} title={scenarioCategory?.label ?? "选择任务场景"} className="scenario-dialog">
      {scenarioCategory && <><p className="scenario-dialog-description">{scenarioCategory.description}</p><div className="scenario-case-list">
        {scenarioCategory.cases.map((item) => <button type="button" className="scenario-case" key={item.title} onClick={() => selectScenario(item.prompt)}><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowUpRight size={17} /></button>)}
      </div><p className="scenario-dialog-footnote">选择后可继续补充需求，发送前仍可编辑。</p></>}
    </Dialog>
    <Dialog open={searchOpen} onClose={() => setSearchOpen(false)} title="搜索对话" className="search-dialog">
      <div className="search-input-wrap"><Search size={19} /><input aria-label="搜索对话内容" placeholder="搜索标题或对话内容…" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus /></div>
      <div className="search-results">{filteredChats.length ? filteredChats.map((conversation) => <button className="search-result" key={conversation.id} onClick={() => selectChat(conversation.id)}><MessageCircle size={18} /><span><strong>{conversation.title}</strong><small>{conversation.messages.find((message) => message.role === "user")?.content}</small></span><ArrowUpRight size={16} /></button>) : <div className="search-empty"><Search size={26} strokeWidth={1.4} /><p>{query ? "没有找到相关对话" : "还没有对话"}</p><span>{query ? "试试其他关键词" : "开始聊天后，可以在这里快速找到它"}</span></div>}</div>
    </Dialog>

    <Dialog open={infoOpen} onClose={() => setInfoOpen(false)} title={`关于 ${frontendConfig.brand.name}`}>
      <div className="agent-info-brand"><BrandMark size={42} /><div><h3>{frontendConfig.brand.name}</h3><p>{frontendConfig.brand.tagline}</p></div><span className="version-badge">{frontendConfig.brand.version}</span></div>
      <p className="dialog-description">{frontendConfig.copy.assistantDescription}</p>
      <div className="info-rows"><div><span>Agent 接口</span><span className="connection-state"><span className={`status-dot ${configured === false ? "warning" : ""}`} />{configured === null ? "正在检查配置" : configured ? "已配置" : "待配置"}</span></div><div><span>对话记录</span><span>保存在当前浏览器</span></div><div><span>回复方式</span><span>实时生成</span></div></div>
      {configured === false && <p className="config-help">请在项目的 .env.local 中配置 Agent 服务地址和 API Key，并重启服务。</p>}
      <div className="info-footnote"><ShieldCheck size={16} /><span>API Key 由服务端保管。消息会发送至你配置的 Agent 服务。</span></div>
      <button className="primary-button full-width" onClick={() => setInfoOpen(false)}>开始对话 <Sparkles size={15} /></button>
    </Dialog>

    <Dialog open={!!editChat} onClose={() => setEditChat(null)} title="重命名对话">
      <form onSubmit={(event) => { event.preventDefault(); if (editChat && editTitle.trim()) { chat.renameChat(editChat.id, editTitle); setEditChat(null); } }}><label htmlFor="conversation-title" className="field-label">对话名称</label><input className="text-field" id="conversation-title" value={editTitle} maxLength={80} onChange={(event) => setEditTitle(event.target.value)} autoFocus /><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setEditChat(null)}>取消</button><button type="submit" className="primary-button" disabled={!editTitle.trim()}><Check size={15} />保存</button></div></form>
    </Dialog>

    <Dialog open={!!projectChat} onClose={() => setProjectChat(null)} title="整理到项目">
      <form onSubmit={(event) => { event.preventDefault(); if (projectChat && projectName.trim()) { chat.moveChatToProject(projectChat.id, projectName); setProjectChat(null); } }}>
        <label htmlFor="conversation-project" className="field-label">项目名称</label>
        <input className="text-field" id="conversation-project" list="conversation-project-names" value={projectName} maxLength={48} placeholder="选择已有项目或输入新项目名称" onChange={(event) => setProjectName(event.target.value)} autoFocus />
        <datalist id="conversation-project-names">{projectNames.map((name) => <option value={name} key={name} />)}</datalist>
        <p className="field-help">同一项目下的对话会集中展示在左侧“项目”分组。</p>
        <div className="dialog-actions">{projectChat?.project && <button type="button" className="secondary-button dialog-leading-action" onClick={() => { chat.moveChatToProject(projectChat.id); setProjectChat(null); }}>移出项目</button>}<button type="button" className="secondary-button" onClick={() => setProjectChat(null)}>取消</button><button type="submit" className="primary-button" disabled={!projectName.trim()}><Check size={15} />保存</button></div>
      </form>
    </Dialog>

    <Dialog open={!!deletingChat} onClose={() => setDeletingChat(null)} title="删除这段对话？">
      <p className="dialog-description">「{deletingChat?.title}」将从当前浏览器中删除，此操作无法撤销。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDeletingChat(null)}>取消</button><button className="danger-button" onClick={() => { if (deletingChat) chat.deleteChat(deletingChat.id); setDeletingChat(null); }}>删除对话</button></div>
    </Dialog>
  </div>;
}
