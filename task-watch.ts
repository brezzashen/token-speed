/** Incrementally tails local Claude Code and Codex profiles; transcript text and source paths never enter worker output. */
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { TaskOutput, type Agent } from './task-output.ts';
import { dialogRetentionMs } from './dialog-speed.ts';

export type Profile = { name: string; agent: Agent; home: string };
type Tail = { offset: number; pending: Buffer; parser: TaskOutput };
export class TaskWatch {
  private tails = new Map<string, Tail>();
  private seen = new Map<string, Set<string>>();
  private profiles: Profile[];
  private count: (text: string) => number;
  private identity: (home: string) => string | undefined;
  private publish: (sample: any) => void;
  constructor(profiles: Profile[], count: (text: string) => number, identity: (home: string) => string | undefined, publish: (sample: any) => void) {
    this.profiles = profiles; this.count = count; this.identity = identity; this.publish = publish;
  }
  async discover() {
    for (const profile of this.profiles) {
      try {
        if (profile.agent === 'codex') {
          const owner = this.identity(profile.home);
          const names = (await readdir(profile.home)).filter(name => /^state_\d+\.sqlite$/.test(name))
            .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
          if (!names.length) continue;
          const db = new DatabaseSync(resolve(profile.home, names[0]), { readOnly: true });
          try {
            const since = Math.floor((Date.now() - dialogRetentionMs) / 1000);
            const rows = (owner === undefined
              ? db.prepare('SELECT rollout_path FROM threads WHERE updated_at >= ?').all(since)
              : db.prepare('SELECT rollout_path FROM threads WHERE updated_at >= ? AND creator_account_id = ?').all(since, owner)) as any[];
            for (const row of rows) this.add(row.rollout_path, profile.name, 'codex', owner);
          } finally { db.close(); }
        } else if (profile.agent === 'claude') {
          await this.claudeFiles(resolve(profile.home, 'projects'), profile.name);
        }
      } catch { /* Missing profiles cannot supply conversation measurements. */ }
    }
  }
  private async claudeFiles(dir: string, alias: string, depth = 0) {
    if (depth > 4) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await this.claudeFiles(path, alias, depth + 1);
      else if (entry.name.endsWith('.jsonl') && (await stat(path)).mtimeMs > Date.now() - dialogRetentionMs) this.add(path, alias, 'claude');
    }
  }
  private add(path: string, account: string, agent: Agent, owner?: string) {
    if (!this.seen.has(account)) this.seen.set(account, new Set());
    if (!this.tails.has(path)) this.tails.set(path, { offset: 0, pending: Buffer.alloc(0), parser: new TaskOutput(this.count, account, agent, owner, this.seen.get(account), path) });
  }
  async poll() {
    for (const [path, tail] of this.tails) {
      try {
        const size = (await stat(path)).size;
        if (size < tail.offset) { this.tails.delete(path); continue; }
        if (size === tail.offset) continue;
        const input = createReadStream(path, { start: tail.offset, end: size - 1 });
        let pending = tail.pending;
        for await (const chunk of input) {
          pending = Buffer.concat([pending, chunk]);
          let index: number;
          while ((index = pending.indexOf(10)) >= 0) {
            const line = pending.subarray(0, index).toString('utf8'); pending = pending.subarray(index + 1);
            try {
              const sample = tail.parser.accept(JSON.parse(line), Date.now() - dialogRetentionMs);
              if (sample) this.publish(sample);
            } catch { /* Incomplete or malformed records cannot supply a speed sample. */ }
          }
        }
        tail.offset = size; tail.pending = pending;
      } catch { this.tails.delete(path); }
    }
  }
}
