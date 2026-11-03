"use client";

import { useEffect, useRef } from "react";
import { ChevronRight, Folder, FolderInput, MessageCircle, Moon, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Search, SquarePen, Sun, Trash2 } from "lucide-react";
import type { Conversation } from "@/lib/types";
import type { CurrentUser } from "@/lib/user-profile";
import { frontendConfig } from "@/config/frontend";

export function Sidebar({ conversations, activeId, onNew, onSearch, onSelect, onClose, onRename, onDelete, onTogglePin, onProject, dark, onTheme, user, onAccount }: {
  conversations: Conversation[]; activeId?: string; onNew: () => void; onSearch: () => void;
  onSelect: (id: string) => void; onClose: () => void; onRename: (chat: Conversation) => void;
  onDelete: (chat: Conversation) => void; onTogglePin: (chat: Conversation) => void; onProject: (chat: Conversation) => void;
  dark: boolean; onTheme: () => void; user: CurrentUser; onAccount: () => void;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const pinnedSectionRef = useRef<HTMLDetailsElement>(null);
  const projectSectionRef = useRef<HTMLDetailsElement>(null);
  const accountName = user.provider === "aliyun" ? user.aliyun?.loginName || user.name : user.name;
  const pinnedChats = conversations.filter((chat) => chat.pinned);
  const projectChats = conversations.filter((chat) => !chat.pinned && chat.project);
  const recentChats = conversations.filter((chat) => !chat.pinned && !chat.project);
  const projectGroups = Array.from(projectChats.reduce((groups, chat) => {
    const name = chat.project!;
    const chats = groups.get(name) ?? [];
    chats.push(chat);
    groups.set(name, chats);
    return groups;
  }, new Map<string, Conversation[]>()));

  useEffect(() => {
    if (pinnedChats.length && pinnedSectionRef.current) pinnedSectionRef.current.open = true;
  }, [pinnedChats.length]);
  useEffect(() => {
    if (projectGroups.length && projectSectionRef.current) projectSectionRef.current.open = true;
  }, [projectGroups.length]);
  useEffect(() => {
    const closeOpenMenus = (event?: Event) => {
      for (const menu of sidebarRef.current?.querySelectorAll<HTMLDetailsElement>(".history-menu[open]") ?? []) {
        if (!event || !menu.contains(event.target as Node)) menu.removeAttribute("open");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeOpenMenus(); };
    document.addEventListener("pointerdown", closeOpenMenus);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeOpenMenus);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const renderConversation = (chat: Conversation) => <div className={`history-item ${activeId === chat.id ? "active" : ""}`} key={chat.id}>
    <button className="history-select" onClick={() => onSelect(chat.id)} aria-current={activeId === chat.id ? "page" : undefined} title={chat.title}>{chat.title}</button>
    <div className="history-actions" aria-label={`${chat.title}的快捷操作`}>
      <button className="history-pin" type="button" onClick={() => {
        if (!chat.pinned && pinnedSectionRef.current) pinnedSectionRef.current.open = true;
        onTogglePin(chat);
      }} aria-label={chat.pinned ? `取消置顶：${chat.title}` : `置顶：${chat.title}`} title={chat.pinned ? "取消置顶" : "置顶"}>
        {chat.pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
      <details className="history-menu"><summary aria-label={`${chat.title}的选项`} title="对话选项"><MoreHorizontal size={17} /></summary><div className="history-popover">
        <button onClick={() => { if (projectSectionRef.current) projectSectionRef.current.open = true; onProject(chat); }}><FolderInput size={15} />{chat.project ? "更换项目" : "加入项目"}</button>
        <button onClick={() => onRename(chat)}><Pencil size={15} />重命名</button>
        <button className="danger-text" onClick={() => onDelete(chat)}><Trash2 size={15} />删除对话</button>
      </div></details>
    </div>
  </div>;

  return <>
    <div className="sidebar-header"><button className="brand" onClick={onNew} aria-label={`${frontendConfig.brand.name} 首页`}><span>{frontendConfig.brand.name}</span></button><button className="icon-button collapse-sidebar" aria-label="收起侧栏" onClick={onClose} title="收起侧栏"><PanelLeftClose size={19} /></button></div>
    <nav className="sidebar-nav" aria-label="对话导航">
      <button className="nav-button new-chat-button" onClick={onNew}><SquarePen size={19} strokeWidth={1.7} /><span>新对话</span><kbd>⌘ K</kbd></button>
      <button className="nav-button" onClick={onSearch}><Search size={19} strokeWidth={1.7} /><span>搜索对话</span><kbd>⌘ F</kbd></button>
    </nav>
    <div className="conversation-list">
      <details ref={pinnedSectionRef} className="conversation-section">
        <summary><span>置顶</span><ChevronRight size={14} /></summary>
        <div className="conversation-section-content">{pinnedChats.length ? pinnedChats.map(renderConversation) : <p className="conversation-section-empty">暂无置顶对话</p>}</div>
      </details>
      <details ref={projectSectionRef} className="conversation-section">
        <summary><span>项目</span><ChevronRight size={14} /></summary>
        <div className="conversation-section-content">{projectGroups.length ? projectGroups.map(([name, chats]) => <section className="conversation-project" key={name}><h2><Folder size={12} />{name}</h2>{chats.map(renderConversation)}</section>) : <p className="conversation-section-empty">暂无项目对话</p>}</div>
      </details>
      <details className="conversation-section" open>
        <summary><span>最近</span><ChevronRight size={14} /></summary>
        <div className="conversation-section-content">{conversations.length === 0 ? <div className="history-empty"><div className="history-empty-content"><MessageCircle size={23} strokeWidth={1.3} /><p>还没有对话</p><span>新对话会自动保存在这里</span></div></div>
          : recentChats.length ? recentChats.map(renderConversation) : <p className="conversation-section-empty">暂无最近对话</p>}</div>
      </details>
    </div>
    <div className="sidebar-bottom"><button className="account-trigger" onClick={onAccount} aria-label="账号设置" title={accountName}><div className="workspace-avatar">{accountName.slice(0, 1).toUpperCase()}</div><div className="workspace-details"><span>{accountName}</span><small>{user.provider === "aliyun" ? "阿里云账号" : "个人空间"}</small></div></button><button className="icon-button" onClick={onTheme} aria-label={dark ? "切换浅色模式" : "切换深色模式"} title={dark ? "切换浅色模式" : "切换深色模式"}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button></div>
  </>;
}
