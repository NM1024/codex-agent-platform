import { spawn } from "node:child_process";

export function filteredCodexEnv(source = process.env) {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "CODEX_HOME",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  return Object.fromEntries(
    allowed.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]),
  );
}

export class CodexRpcClient {
  constructor({
    command = "codex",
    args = ["app-server", "--listen", "stdio://"],
    cwd,
    env = filteredCodexEnv(),
    timeoutMs = 30_000,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.serverHandlers = new Map();
    this.serverPending = new Map();
    this.buffer = "";
    this.closed = false;
    this.process = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.read(chunk));
    this.process.on("error", () => this.fail("CODEX_START_FAILED"));
    this.process.on("exit", () => this.fail("CODEX_EXIT"));
    this.process.stdin.on("error", () => this.fail("CODEX_EXIT"));
  }
  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
      this.fail("CODEX_PROTOCOL");
      this.process.kill();
      return;
    }
    let n;
    while ((n = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, n);
      this.buffer = this.buffer.slice(n + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.fail("CODEX_PROTOCOL");
        this.process.kill();
        return;
      }
      if (msg.method) {
        if(msg.method==='serverRequest/resolved')this.serverPending.delete(msg.params?.requestId);
        if (msg.id !== undefined) {
          const handler=this.serverHandlers.get(msg.method);
          if(handler) {
            if(this.serverPending.has(msg.id)||this.serverPending.size>=20){this.fail('CODEX_PROTOCOL');this.process?.kill();return;}
            const entry={};this.serverPending.set(msg.id,entry);
            Promise.resolve().then(()=>handler(msg.params??{},msg.id)).then(result=>{
              if(this.closed||this.serverPending.get(msg.id)!==entry)return;
              this.serverPending.delete(msg.id);this.send({id:msg.id,result});
            }).catch(()=>{
              if(this.closed||this.serverPending.get(msg.id)!==entry)return;
              this.serverPending.delete(msg.id);this.send({id:msg.id,error:{code:-32602,message:'User input request unavailable'}});
            });
          }else {
          // Never grant shell, filesystem or external tool approvals.
          const result = msg.method.endsWith("/requestApproval")
            ? { decision: "decline" }
            : null;
          this.send(
            result
              ? { id: msg.id, result }
              : {
                  id: msg.id,
                  error: {
                    code: -32601,
                    message: "Unsupported server request",
                  },
                },
          );
          }
        }
        for (const listener of this.listeners) {
          try {
            listener(msg);
          } catch {
            this.fail("CODEX_LISTENER_FAILED");
          }
        }
      } else if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error)
          entry.reject(
            Object.assign(new Error("CODEX_RPC_ERROR"), {
              code: "CODEX_RPC_ERROR",
            }),
          );
        else entry.resolve(msg.result);
      }
    }
  }
  send(message) {
    if (this.closed) throw new Error("CODEX_EXIT");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  handleServerRequest(method,handler) {
    // Clarification is the sole extensible server request. Approval/tool execution
    // requests keep their fail-closed transport behavior.
    if(method!=='item/tool/requestUserInput'||typeof handler!=='function')throw new Error('UNSUPPORTED_SERVER_HANDLER');
    this.serverHandlers.set(method,handler);
    return ()=>this.serverHandlers.delete(method);
  }
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error("CODEX_EXIT"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CODEX_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("CODEX_EXIT"));
      }
    });
  }
  notify(method, params = {}) {
    this.send({ method, params });
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fail(code) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(code));
    }
    this.pending.clear();
    this.serverPending.clear();
    for (const listener of this.listeners) {
      try {
        listener({ method: "transport/closed", params: { code } });
      } catch {}
    }
  }
  async close() {
    this.fail("CODEX_EXIT");
    if (this.process.exitCode !== null) return;
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        this.process.kill("SIGKILL");
        resolve();
      }, 1000);
      this.process.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
