"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { consumeAgentStream } from "@/lib/agent-stream";
import { chatErrorMessage } from "@/lib/chat-errors";
import { emptyStore, restoreStore, STORAGE_KEY } from "@/lib/storage";
import { reloadAfterAuth } from "@/lib/auth-client";
import type { ChatMessage, ChatStore, Conversation, UploadedAttachment } from "@/lib/types";

export function useChat(userId: string) {
  const storageKey = `${STORAGE_KEY}:${userId}`;
  const [store, setStore] = useState<ChatStore>(emptyStore);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftThreadId, setDraftThreadId] = useState(() => crypto.randomUUID());
  const controllerRef = useRef<AbortController | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      try { setStore(restoreStore(localStorage.getItem(storageKey))); }
      catch { setNotice("无法读取已保存的对话。新对话仍可正常使用。"); }
      readyRef.current = true;
      setReady(true);
    });
    return () => { live = false; controllerRef.current?.abort(); };
  }, [storageKey]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(storageKey, JSON.stringify(store)); }
      catch { setNotice("浏览器存储空间不足，本次对话可能无法保存。请导出需要保留的内容。"); }
    }, 300);
    return () => clearTimeout(timer);
  }, [store, ready, storageKey]);

  // Flush the latest partial response when the user reloads or closes the page.
  useEffect(() => {
    const save = () => {
      if (readyRef.current) {
        try { localStorage.setItem(storageKey, JSON.stringify(store)); } catch { /* Reported by regular persistence. */ }
      }
    };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [store, storageKey]);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setBusy(false);
  }, []);

  const run = useCallback(async (conversation: Conversation, messages: ChatMessage[]) => {
    if (controllerRef.current || !readyRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const assistantId = crypto.randomUUID();
    const assistant: ChatMessage = { id: assistantId, role: "assistant", content: "", status: "streaming", startedAt: Date.now() };
    setBusy(true);
    setStore((previous) => ({
      activeId: conversation.id,
      conversations: [
        { ...conversation, updatedAt: Date.now(), messages: [...messages, assistant] },
        ...previous.conversations.filter((chat) => chat.id !== conversation.id),
      ],
    }));

    const update = (patch: Partial<ChatMessage>) => {
      setStore((previous) => ({ ...previous, conversations: previous.conversations.map((chat) => chat.id === conversation.id ? {
        ...chat, messages: chat.messages.map((message) => message.id === assistantId ? { ...message, ...patch } : message),
      } : chat) }));
    };

    let responseStarted = false;
    let latest: Pick<ChatMessage, "content" | "reasoning" | "tools" | "runActivities"> = { content: "" };
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream", "X-Account-ID": userId },
        body: JSON.stringify({
          threadId: conversation.id,
          runId: crypto.randomUUID(),
          messages: messages.filter((message) => message.content.trim() || message.attachments?.length)
            .map(({ id, role, content, attachments }) => ({ id, role, content, ...(attachments?.length ? { attachments } : {}) })),
        }),
        signal: controller.signal,
      });
      if (response.status === 401) { reloadAfterAuth("/login"); throw new Error("登录已失效，请重新登录。"); }
      responseStarted = response.ok;
      await consumeAgentStream(response, (snapshot) => { latest = snapshot; update(snapshot); });
      update({ ...latest, status: "complete", completedAt: Date.now() });
    } catch (error) {
      if (controller.signal.aborted) update({ status: "stopped", completedAt: Date.now() });
      else update({ status: "error", error: chatErrorMessage(error, responseStarted), completedAt: Date.now() });
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  }, [userId]);

  const active = store.conversations.find((chat) => chat.id === store.activeId) || null;

  const send = useCallback((content: string, attachments: UploadedAttachment[] = []) => {
    const text = content.trim();
    if ((!text && !attachments.length) || controllerRef.current || !readyRef.current) return;
    const conversation: Conversation = active || {
      id: draftThreadId, title: Array.from(text || attachments[0]?.name || "文件对话").slice(0, 28).join(""),
      createdAt: Date.now(), updatedAt: Date.now(), messages: [],
    };
    void run(conversation, [...conversation.messages, {
      id: crypto.randomUUID(), role: "user", content: text, status: "complete",
      ...(attachments.length ? { attachments } : {}),
    }]);
  }, [active, draftThreadId, run]);

  const regenerate = useCallback(() => {
    if (!active || controllerRef.current) return;
    const lastUser = active.messages.findLastIndex((message) => message.role === "user");
    if (lastUser >= 0) void run(active, active.messages.slice(0, lastUser + 1));
  }, [active, run]);

  const newChat = useCallback(() => {
    stop();
    setDraftThreadId(crypto.randomUUID());
    setStore((previous) => ({ ...previous, activeId: null }));
  }, [stop]);

  const selectChat = useCallback((id: string) => {
    stop();
    setStore((previous) => ({ ...previous, activeId: id }));
  }, [stop]);

  const deleteChat = useCallback((id: string) => {
    if (id === store.activeId) stop();
    setStore((previous) => ({
      activeId: previous.activeId === id ? null : previous.activeId,
      conversations: previous.conversations.filter((chat) => chat.id !== id),
    }));
  }, [store.activeId, stop]);

  const renameChat = useCallback((id: string, title: string) => {
    if (!title.trim()) return;
    setStore((previous) => ({ ...previous, conversations: previous.conversations.map((chat) => chat.id === id ? { ...chat, title: title.trim().slice(0, 80) } : chat) }));
  }, []);

  const togglePinChat = useCallback((id: string) => {
    setStore((previous) => ({
      ...previous,
      conversations: previous.conversations.map((chat) => chat.id === id ? { ...chat, pinned: !chat.pinned } : chat),
    }));
  }, []);

  const moveChatToProject = useCallback((id: string, project?: string) => {
    const normalized = project?.trim().slice(0, 48);
    setStore((previous) => ({
      ...previous,
      conversations: previous.conversations.map((chat) => chat.id === id
        ? { ...chat, project: normalized || undefined }
        : chat),
    }));
  }, []);

  return { active, conversations: store.conversations, threadId: active?.id ?? draftThreadId, ready, busy, notice, setNotice, send, stop, regenerate, newChat, selectChat, deleteChat, renameChat, togglePinChat, moveChatToProject };
}
