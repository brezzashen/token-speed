/** Produces private text/reasoning measurements for DialogSpeed; explicit item timing and response usage must match, and missing data never becomes zero.
 * Claude yields one whole-response sample instead: interactive Claude Code stretches thinkingDurationMs over text
 * generation and flushes text records in a burst, so only the response as a whole has trustworthy timing.
 * speed.test.ts protects both providers. */
import { normalizeMode } from './speed-policy.ts';
export type Agent = 'claude' | 'codex';
export class TaskOutput {
  private model = 'unknown';
  private mode = 'unknown';
  private owner = false;
  private conversationId = 'unknown';
  private reasoning = new Map<string, { spans: [number, number][]; missing: boolean; model: string; mode: string; ids: Set<string> }>();
  private claudeResponses = new Map<string, { start: number | null; missing: boolean; last: number; rows: Set<string> }>();
  private count: (text: string) => number;
  private account: string;
  private agent: Agent;
  private expectedOwner?: string;
  private seen: Set<string>;
  // Without an expected owner every Codex session in the profile counts; with one, only sessions it created.
  constructor(count: (text: string) => number, account: string, agent: Agent, expectedOwner?: string, seen = new Set<string>(), conversationId = 'unknown') {
    this.count = count; this.account = account; this.agent = agent; this.expectedOwner = expectedOwner; this.seen = seen;
    this.conversationId = conversationId;
    this.owner = expectedOwner === undefined;
  }
  accept(row: any, since: number) {
    const p = row.payload;
    if (row.type === 'session_meta') {
      this.owner = this.expectedOwner === undefined || p?.creator_account_id === this.expectedOwner;
      this.conversationId = p?.id ?? this.conversationId;
    }
    if (row.type === 'turn_context') {
      this.model = p?.model ?? 'unknown';
      if (p && Object.hasOwn(p, 'service_tier')) this.mode = normalizeMode(p.service_tier);
    }
    if (p?.type === 'thread_settings_applied') {
      this.model = p.thread_settings?.model ?? this.model;
      if (p.thread_settings && Object.hasOwn(p.thread_settings, 'service_tier')) this.mode = normalizeMode(p.thread_settings.service_tier);
    }
    if (this.agent === 'claude') return row.type === 'assistant' && Array.isArray(row.message?.content) ? this.claudeResponse(row, since) : null;
    if (!this.owner) return null;
    if (p?.type === 'item_completed' && p.item?.type === 'Reasoning') {
      if (typeof p.turn_id !== 'string' || typeof p.item.id !== 'string') return null;
      const pending = this.reasoning.get(p.turn_id) ?? { spans: [], missing: false, model: this.model, mode: this.mode, ids: new Set<string>() };
      if (pending.ids.has(p.item.id)) return null;
      pending.ids.add(p.item.id);
      if (Number.isFinite(p.started_at_ms) && Number.isFinite(p.completed_at_ms) && p.completed_at_ms >= p.started_at_ms) {
        pending.spans.push([p.started_at_ms, p.completed_at_ms]);
      } else pending.missing = true;
      pending.missing ||= pending.model !== this.model || pending.mode !== this.mode;
      this.reasoning.set(p.turn_id, pending);
      if (this.reasoning.size > 1000) this.reasoning.delete(this.reasoning.keys().next().value!);
      return null;
    }
    if (row.type === 'token_usage_record') return this.reasoningSample(row, since);
    const item = p?.item;
    if (p?.type !== 'item_completed' || item?.type !== 'AgentMessage') return null;
    const end = p.completed_at_ms, start = p.started_at_ms;
    const id = item?.id;
    if (typeof id !== 'string' || this.seen.has(id) || !Number.isFinite(end) || end < since) return null;
    const text = (Array.isArray(item.content) ? item.content : [])
      .filter((block: any) => ['text', 'Text'].includes(block.type)).map((block: any) => block.text ?? '').join('');
    if (!text || item.model === '<synthetic>') return null;
    this.seen.add(id);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
    const estimatedTokens = this.count(text);
    const outputMs = Number.isFinite(start) && end - start >= 250 ? end - start : null;
    return { model: this.model, account: this.account,
      sampleId: `text:${id}`, conversationId: this.conversationId, kind: 'text', mode: this.mode, speedBasis: 'request',
      status: outputMs ? 'sampled' : 'unavailable',
      reason: outputMs ? null : 'missing_output_timing', sampledAt: new Date(end).toISOString(),
      startedAt: outputMs ? new Date(start).toISOString() : null,
      updatedAt: new Date().toISOString(), estimatedTokens, measuredTokens: estimatedTokens,
      outputMs, chunks: null, firstTextMs: null,
      tokensPerSecond: outputMs ? estimatedTokens / (outputMs / 1000) : null,
      tokenizer: 'o200k_base', basis: 'content_estimate', source: 'task' };
  }
  // Claude Code writes one record per content block and copies the final response usage onto each. Generation starts
  // at the leading thinking block (its timestamp minus thinkingDurationMs, which excludes time to first token) and ends
  // at the response's last block record. Responses without a timed leading thinking block have no start and stay
  // unavailable. Re-emitting under one sampleId lets DialogSpeed replace the earlier partial reading.
  private claudeResponse(row: any, since: number) {
    const message = row.message, usage = message.usage, at = Date.parse(row.timestamp);
    if (typeof message.id !== 'string' || message.model === '<synthetic>' || !Number.isFinite(at) || at < since) return null;
    const thinking = message.content.some((block: any) => ['thinking', 'redacted_thinking'].includes(block?.type));
    let pending = this.claudeResponses.get(message.id);
    if (!pending) {
      const ms = row.thinkingDurationMs, timed = thinking && Number.isFinite(ms) && ms >= 0;
      pending = { start: timed ? at - ms : null, missing: !timed, last: at, rows: new Set<string>() };
      this.claudeResponses.set(message.id, pending);
      if (this.claudeResponses.size > 1000) this.claudeResponses.delete(this.claudeResponses.keys().next().value!);
    }
    const rowId = String(row.uuid ?? `${at}:${pending.rows.size}`);
    if (pending.rows.has(rowId)) return null;
    pending.rows.add(rowId);
    pending.last = Math.max(pending.last, at);
    const tokens = usage?.output_tokens, duration = pending.start === null ? 0 : pending.last - pending.start;
    const valid = !pending.missing && pending.start !== null && pending.start >= since && duration >= 250
      && Number.isSafeInteger(tokens) && tokens > 0;
    return { model: message.model ?? 'unknown', account: this.account, mode: normalizeMode(usage?.speed), speedBasis: 'response',
      sampleId: `response:${message.id}`, conversationId: row.sessionId ?? this.conversationId, kind: 'response', source: 'task',
      status: valid ? 'sampled' : 'unavailable', reason: valid ? null : 'missing_response_timing',
      sampledAt: new Date(pending.last).toISOString(), measuredTokens: valid ? tokens : 0, estimatedTokens: valid ? tokens : 0,
      startedAt: valid ? new Date(pending.start!).toISOString() : null,
      outputMs: valid ? duration : null, tokensPerSecond: valid ? tokens / (duration / 1000) : null,
      basis: 'recorded_response', firstTextMs: null, updatedAt: new Date().toISOString() };
  }
  private reasoningSample(row: any, since: number) {
    const p = row.payload, pending = this.reasoning.get(p.turn_id);
    this.reasoning.delete(p.turn_id);
    const id = typeof p.response_id === 'string' ? `reasoning:${p.response_id}` : null;
    const end = Date.parse(row.timestamp), tokens = p.usage?.reasoning_output_tokens;
    if (!id || this.seen.has(id) || !Number.isFinite(end) || end < since || !Number.isSafeInteger(tokens) || tokens <= 0
      || !Number.isSafeInteger(p.usage?.output_tokens) || tokens > p.usage.output_tokens) return null;
    this.seen.add(id);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
    let duration = 0, until = -Infinity;
    for (const [start, finish] of [...(pending?.spans ?? [])].sort((a, b) => a[0] - b[0])) {
      duration += Math.max(0, finish - Math.max(start, until)); until = Math.max(until, finish);
    }
    const valid = pending && !pending.missing && duration >= 250
      && pending.spans.every(([start, finish]) => start >= since && finish <= end);
    return { model: pending?.model ?? this.model, account: this.account,
      mode: typeof p.service_tier === 'string' ? normalizeMode(p.service_tier) : pending?.mode ?? this.mode,
      speedBasis: typeof p.service_tier === 'string' ? 'response' : 'request',
      sampleId: id, conversationId: this.conversationId, kind: 'reasoning', source: 'task',
      status: valid ? 'sampled' : 'unavailable', reason: valid ? null : 'missing_reasoning_timing',
      sampledAt: new Date(end).toISOString(), measuredTokens: tokens, estimatedTokens: tokens,
      startedAt: valid ? new Date(Math.min(...pending.spans.map(span => span[0]))).toISOString() : null,
      outputMs: valid ? duration : null, tokensPerSecond: valid ? tokens / (duration / 1000) : null,
      basis: 'recorded_reasoning', firstTextMs: null };
  }
}
