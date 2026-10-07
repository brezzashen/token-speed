/** Aggregates complete private generation segments into rolling model/account/mode averages; speed.test.ts protects interval boundaries, weighting and privacy. */
import { sampleKey } from './speed-policy.ts';
export const dialogWindowMs = 3600_000;
export const speedWindows = [
  { id: 'last_hour', windowMs: dialogWindowMs },
  { id: 'last_three_hours', windowMs: 3 * dialogWindowMs },
  { id: 'last_five_hours', windowMs: 5 * dialogWindowMs },
  { id: 'last_24_hours', windowMs: 24 * dialogWindowMs },
] as const;
export const dialogRetentionMs = speedWindows[3].windowMs;
export class DialogSpeed {
  private groups = new Map<string, Map<string, any>>();
  accept(sample: any) {
    const key = `${sample.account}|${sampleKey(sample)}`;
    if (!this.groups.has(key)) this.groups.set(key, new Map());
    this.groups.get(key)!.set(sample.sampleId, sample);
  }
  readings(now = Date.now(), windowMs = dialogWindowMs) {
    if (!speedWindows.some(window => window.windowMs === windowMs)) throw new Error('Unsupported speed interval');
    const result: any[] = [];
    for (const [key, records] of this.groups) {
      for (const [id, row] of records) if (Date.parse(row.sampledAt) <= now - dialogRetentionMs) records.delete(id);
      if (!records.size) { this.groups.delete(key); continue; }
      const rows = [...records.values()].filter(row => Date.parse(row.sampledAt) > now - windowMs && Date.parse(row.sampledAt) <= now);
      if (!rows.length) continue;
      const valid = rows.filter(row => Number.isFinite(row.outputMs) && row.outputMs >= 250
        && Number.isFinite(row.measuredTokens) && row.measuredTokens > 0 && ['text', 'reasoning', 'response'].includes(row.kind)
        && (row.startedAt ? Date.parse(row.startedAt) : Date.parse(row.sampledAt) - row.outputMs) >= now - windowMs
        && (!row.startedAt || Date.parse(row.startedAt) <= Date.parse(row.sampledAt) - row.outputMs));
      const text = valid.filter(row => row.kind === 'text'), reasoning = valid.filter(row => row.kind === 'reasoning');
      const response = valid.filter(row => row.kind === 'response');
      const sum = (items: any[], field: string) => items.reduce((total, item) => total + item[field], 0);
      const outputTokens = sum(text, 'measuredTokens'), reasoningTokens = sum(reasoning, 'measuredTokens');
      const outputDurationMs = sum(text, 'outputMs'), reasoningDurationMs = sum(reasoning, 'outputMs');
      const responseTokens = sum(response, 'measuredTokens'), responseDurationMs = sum(response, 'outputMs');
      const outputMs = outputDurationMs + reasoningDurationMs + responseDurationMs;
      const measuredTokens = outputTokens + reasoningTokens + responseTokens;
      const last = [...rows].sort((a, b) => Date.parse(b.sampledAt) - Date.parse(a.sampledAt))[0];
      const bases = new Set(valid.map(row => row.speedBasis));
      result.push({ model: last.model, account: last.account, mode: last.mode,
        speedBasis: bases.size === 1 ? [...bases][0] : bases.size ? 'mixed' : last.speedBasis, source: 'task',
        status: valid.length ? 'sampled' : 'unavailable', reason: valid.length ? null : 'missing_output_timing',
        sampledAt: last.sampledAt, updatedAt: new Date(now).toISOString(), windowStart: new Date(now - windowMs).toISOString(),
        estimatedTokens: measuredTokens, measuredTokens, outputMs: outputMs || null, firstTextMs: null,
        tokensPerSecond: outputMs ? measuredTokens / (outputMs / 1000) : null,
        outputTokens, reasoningTokens, outputDurationMs, reasoningDurationMs,
        outputTokensPerSecond: outputDurationMs ? outputTokens / (outputDurationMs / 1000) : null,
        reasoningTokensPerSecond: reasoningDurationMs ? reasoningTokens / (reasoningDurationMs / 1000) : null,
        responseTokens, responseDurationMs,
        responseTokensPerSecond: responseDurationMs ? responseTokens / (responseDurationMs / 1000) : null,
        sampleCount: valid.length, outputSampleCount: text.length, reasoningSampleCount: reasoning.length,
        responseSampleCount: response.length,
        conversationCount: new Set(valid.map(row => row.conversationId)).size, excludedSamples: rows.length - valid.length,
        tokenizer: 'o200k_base', basis: response.length ? 'recorded_response'
          : reasoning.length ? 'recorded_reasoning_and_estimated_text' : 'content_estimate' });
    }
    return result;
  }
  intervals(now = Date.now()) {
    return speedWindows.map(window => ({ ...window, start: new Date(now - window.windowMs).toISOString(),
      end: new Date(now).toISOString(), samples: this.readings(now, window.windowMs) }));
  }
}
