/** Incremental SSE decoding: UTF-8 boundaries, CR/LF/CRLF, comments and multiline data. */
export async function* readSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let ended = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });

  function line(value: string): string | undefined {
    if (value === "") {
      const event = data.length ? data.join("\n") : undefined;
      data = [];
      return event;
    }
    if (value === "data") data.push("");
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  }

  try {
    while (!ended) {
      if (signal?.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      ended = done;
      buffer += decoder.decode(value, { stream: !done });
      // A broken peer should not be able to buffer an unbounded SSE frame.
      if (buffer.length + data.reduce((n, part) => n + part.length, 0) > 2_000_000) {
        throw new Error("服务返回的单条消息过大，请重新开始对话。");
      }
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== "\r" && buffer[i] !== "\n") continue;
        if (buffer[i] === "\r" && i === buffer.length - 1 && !done) break;
        const event = line(buffer.slice(start, i));
        if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
        if (event !== undefined) yield event;
      }
      buffer = buffer.slice(start);
    }
    if (buffer) line(buffer);
    if (data.length) yield data.join("\n");
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
