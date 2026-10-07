/** Resolves the local agent profiles to watch; speed.test.ts protects parsing. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Profile } from './task-watch.ts';

const expand = (path: string) => path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
// Format: name:agent:home, comma separated; agent is claude or codex. The default watches the standard CLI homes.
export function parseProfiles(value = process.env.TOKEN_SPEED_PROFILES) {
  const fallback = `claude:claude:${process.env.CLAUDE_CONFIG_DIR ?? '~/.claude'},codex:codex:${process.env.CODEX_HOME ?? '~/.codex'}`;
  return (value?.trim() || fallback).split(',').map(entry => {
    const [name, agent, ...rest] = entry.trim().split(':');
    const home = rest.join(':');
    if (!/^[\w.-]{1,32}$/.test(name ?? '') || !['claude', 'codex'].includes(agent) || !home) throw new Error(`Invalid profile: ${entry}`);
    return { name, agent, home: expand(home) } as Profile;
  });
}
// Codex profiles can hold sessions from several ChatGPT logins; the signed-in account narrows them when it is known.
export function codexOwner(home: string) {
  try {
    const id = JSON.parse(readFileSync(resolve(home, 'auth.json'), 'utf8')).tokens?.account_id;
    return typeof id === 'string' && id ? id : undefined;
  } catch { return undefined; }
}
