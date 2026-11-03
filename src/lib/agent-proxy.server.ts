import { readSSE } from "./sse";

type ProxyOptions = {
  signal: AbortSignal;
  onClose: () => void;
  onCancel: () => void;
  onError: (error: unknown) => { code: string; message: string };
  heartbeatMs?: number;
};

/** Forward complete SSE frames so a broken partial frame cannot swallow RUN_ERROR. */
export function proxyAgentStream(body: ReadableStream<Uint8Array>, options: ProxyOptions) {
  const events = readSSE(body, options.signal);
  const encoder = new TextEncoder();
  const frame = (data: string) => encoder.encode(data.split("\n").map((line) => `data: ${line}`).join("\n") + "\n\n");
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval>;
  const cleanup = () => { closed = true; clearInterval(heartbeat); options.onClose(); };
  return new ReadableStream<Uint8Array>({
    start(destination) {
      heartbeat = setInterval(() => {
        // Do not queue heartbeats behind a slow consumer. Comments do not become
        // AG-UI events, and keep the browser/proxy connection alive during tools.
        if (!closed && (destination.desiredSize ?? 0) > 0) destination.enqueue(encoder.encode(": heartbeat\n\n"));
      }, options.heartbeatMs ?? 15_000);
    },
    async pull(destination) {
      try {
        const { value, done } = await events.next();
        if (closed) return;
        if (done) { cleanup(); destination.close(); return; }
        destination.enqueue(frame(value));
        let terminal = value.trim() === "[DONE]";
        try { const type = JSON.parse(value).type; terminal ||= type === "RUN_FINISHED" || type === "RUN_ERROR"; } catch { /* Client reports malformed JSON. */ }
        if (terminal) { cleanup(); destination.close(); await events.return(undefined); }
      } catch (error) {
        if (closed) return;
        const failure = options.onError(error);
        destination.enqueue(frame(JSON.stringify({ type: "RUN_ERROR", ...failure })));
        cleanup(); destination.close();
      }
    },
    async cancel() {
      cleanup(); options.onCancel();
      await events.return(undefined).catch(() => {});
    },
  });
}
