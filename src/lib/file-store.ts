export interface StoredFileInfo { size: number; etag?: string; modifiedAt?: string; }
export interface FileStore {
  stat(key: string): Promise<StoredFileInfo>;
  read(key: string, options: { range?: string; etag?: string; signal: AbortSignal }): Promise<{ body: ReadableStream<Uint8Array>; length?: number; contentRange?: string; status: number }>;
  close?(): Promise<void>;
}
