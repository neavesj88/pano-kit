/* Talking to a running PhotoCraft through its own MCP bridge.
 *
 * PhotoCraft's CLI speaks MCP on stdio and forwards each tool to the desktop
 * app's authenticated control port (photocraft --control PORT
 * --control-token-file FILE). One child process is kept for the session and
 * restarted if it dies; when the app is not running every call fails with
 * PhotoCraft's own message, which is passed on as it is.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface PhotoCraftConfig {
  cli: string;
  port: number;
  tokenFile: string;
}

export interface ActiveDoc {
  index: number;
  name: string;
  /** As PhotoCraft reports it: absolute when opened by hand, relative to the automation root when opened through it. */
  path: string | null;
  revision: number;
  dirty: boolean;
}

export class PhotoCraft {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  // A plain field, not a constructor parameter property: Node runs this file by stripping types, which cannot rewrite those.
  private cfg: PhotoCraftConfig;
  constructor(cfg: PhotoCraftConfig) {
    this.cfg = cfg;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = spawn(this.cfg.cli, ["mcp", "--bridge", `127.0.0.1:${this.cfg.port}`, "--control-token-file", this.cfg.tokenFile], { windowsHide: true });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.onData(d));
    child.stderr.on("data", () => { /* the bridge logs here; nothing to act on */ });
    const fail = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      this.pending.clear();
    };
    child.on("exit", code => fail(`PhotoCraft's CLI stopped (exit ${code})`));
    child.on("error", e => fail(`Could not start PhotoCraft's CLI: ${e.message}`));
    this.ready = this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pano-desk", version: "1" } }, 15000)
      .then(() => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); });
    this.ready.catch(() => fail("PhotoCraft's CLI did not answer"));
    return this.ready;
  }

  private onData(d: string) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      const p = m.id != null ? this.pending.get(m.id) : undefined;
      if (!p) continue;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message ?? "PhotoCraft refused the request"));
      else p.resolve(m.result);
    }
  }

  private rpc(method: string, params: unknown, timeoutMs = 60000): Promise<any> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("PhotoCraft's CLI is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PhotoCraft did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** A tool's text result, parsed as JSON when it is JSON. Tool errors throw with PhotoCraft's words. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    await this.start();
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    if (r?.isError) throw new Error(text.replace(/^bridge:\s*/, "") || "PhotoCraft reported an error");
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Every open document, and which one is in front. */
  async documents(): Promise<{ active: number | null; docs: ActiveDoc[] }> {
    const session = (await this.tool("session_list"))?.session;
    const docs: ActiveDoc[] = (session?.documents ?? []).map((d: any) => ({ index: d.index, name: d.name, path: d.path ?? null, revision: d.revision, dirty: !!d.dirty }));
    return { active: session?.active ?? null, docs };
  }

  /** The document in front in PhotoCraft, or null when none is open. */
  async activeDoc(): Promise<ActiveDoc | null> {
    const { active, docs } = await this.documents();
    return docs.find(d => d.index === active) ?? null;
  }

  /** Open a file beneath PhotoCraft's automation read root (path relative to it, forward slashes). */
  open(relPath: string) {
    return this.tool("doc_open", { path: relPath });
  }

  /** Export the front document, flattened, beneath its automation write root. Its layers stay in PhotoCraft. */
  exportActive(relPath: string) {
    return this.tool("doc_export", { path: relPath });
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
}
