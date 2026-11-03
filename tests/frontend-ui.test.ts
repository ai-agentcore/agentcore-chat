import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveFrontendConfig } from "../src/config/frontend";

test("frontend configuration validates brand, copy and theme overrides", () => {
  const config = resolveFrontendConfig({
    appName: "团队助手",
    pageTitle: "团队助手 · 工作台",
    welcomeTitle: "今天从哪里开始？",
    defaultTheme: "dark",
    lightAccent: "#123abc",
    darkAccent: "invalid",
  });
  assert.equal(config.brand.name, "团队助手");
  assert.equal(config.brand.title, "团队助手 · 工作台");
  assert.equal(config.copy.welcomeTitle, "今天从哪里开始？");
  assert.equal(config.theme.defaultMode, "dark");
  assert.equal(config.theme.light.accent, "#123abc");
  assert.equal(config.theme.dark.accent, "#87bfae");
  assert.equal(config.copy.scenarios.length, 4);
});

test("conversation navigation includes pin, project and recent organization", async () => {
  const [sidebar, chatApp, storage] = await Promise.all([
    readFile(new URL("../src/components/sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/chat-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/storage.ts", import.meta.url), "utf8"),
  ]);
  assert.match(sidebar, />置顶<[\s\S]*>项目<[\s\S]*>最近</);
  assert.match(sidebar, /onTogglePin\(chat\)/);
  assert.match(sidebar, /onProject\(chat\)/);
  assert.match(chatApp, /chat\.togglePinChat/);
  assert.match(chatApp, /chat\.moveChatToProject/);
  assert.match(storage, /pinned: z\.boolean\(\)\.optional\(\)/);
});

test("long conversations expose an accessible minimap and scenario drill-down", async () => {
  const [minimap, chatApp, message] = await Promise.all([
    readFile(new URL("../src/components/conversation-minimap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/chat-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/message.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(minimap, /aria-label="对话快速导航"/);
  assert.match(minimap, /prefers-reduced-motion: reduce/);
  assert.match(minimap, /ResizeObserver/);
  assert.match(message, /data-message-id=\{message\.id\}/);
  assert.match(chatApp, /<ConversationMinimap/);
  assert.match(chatApp, /className="scenario-case"/);
});
