export function chatErrorMessage(error: unknown, responseStarted: boolean) {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof TypeError || /^(network\s?error|failed to fetch|load failed|fetch failed|network request failed|terminated)\b/i.test(message)) {
    return responseStarted
      ? "回复连接中断，已保留收到的内容。请检查网络后点击重试。"
      : "无法连接对话服务，请检查网络和应用服务是否正常，再重试。";
  }
  return message || "连接中断，已保留收到的内容。请重试。";
}
