import { lifecycleDetails } from "./codex.mjs";
import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { safeDirectory, atomicJson, readRegular } from "../files.mjs";

export class EventOutbox {
  constructor({ workspace, send }) {
    this.directory = join(workspace, ".agent-events");
    this.send = send;
    this.closed = false;
  }
  async publish(run_id, code, details) {
    if (!/^[a-f0-9-]{36}$/.test(run_id)) throw new Error("INVALID_RUN");
    await safeDirectory(this.directory);
    await atomicJson(join(this.directory, `${run_id}.${details?.generation ?? 0}.${code}.json`), {
      run_id, code, ...(details ? { details: lifecycleDetails(details) } : {}),
    });
    await this.flush();
  }
  flush() {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = this.sendPending().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  async sendPending() {
    do {
      this.again = false;
      await safeDirectory(this.directory);
      for (const name of await readdir(this.directory)) {
        if (this.closed) return;
        if (!/^[a-f0-9-]{36}(?:\.[0-9]+\.[A-Z_]+)?\.json$/.test(name)) continue;
        const path = join(this.directory, name);
        try {
          const event = JSON.parse(
            await readRegular(this.directory, path, 16384),
          );
          await this.send(event);
          await unlink(path);
        } catch {
          /* Keep uncertain delivery durable; its receiver is idempotent. */
        }
      }
    } while (this.again && !this.closed);
    if (!this.closed && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 15000);
  }
  async stop() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.flushing;
  }
}
