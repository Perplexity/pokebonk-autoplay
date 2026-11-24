/**
 * A small Chrome DevTools Protocol client over the page target's WebSocket (Node's built-in WebSocket, no dependencies).
 */
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

export class CdpError extends Error {
  code?: number;
  constructor(method: string, message: string, code?: number) { super(`${method}: ${message}`); this.code = code; }
}

export class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: any) => void>>();
  closed = false;
  onClose: () => void = () => {};

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new CdpError(p.method, msg.error.message, msg.error.code));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) { try { h(msg.params); } catch (e) { console.error('[cdp] handler', msg.method, e); } }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new CdpError(p.method, 'connection closed'));
      this.pending.clear();
      this.onClose();
    });
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { try { ws.close(); } catch { /* not open */ } reject(new Error('CDP connect timeout')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(new Cdp(ws)); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`CDP connect failed: ${url}`)); });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(method, 'connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new CdpError(method, 'timeout')); }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: any) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Evaluate an expression in the page and return its JSON value. Throws with the page's error text. */
  async eval<T = any>(expression: string, opts: { awaitPromise?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: opts.awaitPromise ?? false, userGesture: false,
    }, opts.timeoutMs);
    if (r.exceptionDetails) throw new CdpError('Runtime.evaluate', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value as T;
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}
