import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TaskOutput } from './task-output.ts';
import { outputSpeed } from './web/output-speed.ts';
import { normalizeMode, sampleKey } from './speed-policy.ts';
import { parseProfiles } from './profiles.ts';
import { TaskWatch } from './task-watch.ts';
import { DialogSpeed } from './dialog-speed.ts';
import { intervalSpeed } from './web/interval-speed.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const message = (id = 'm1', start = 1000, end = 3000) => ({ type: 'event_msg', payload: { type: 'item_completed',
  started_at_ms: start, completed_at_ms: end, item: { type: 'AgentMessage', id,
    content: [{ type: 'Text', text: '123456' }, { type: 'Reasoning', text: 'not output' }] } } });
function owned(seen?: Set<string>) {
  const parser = new TaskOutput(text => text.length, 'codex', 'codex', 'owner', seen);
  parser.accept({ type: 'session_meta', payload: { creator_account_id: 'owner' } }, 0);
  parser.accept({ type: 'turn_context', payload: { model: 'gpt-example' } }, 0);
  return parser;
}
test('task speed uses explicit timing, omits reasoning and deduplicates across replayed files', () => {
  const seen = new Set<string>(), first = owned(seen), replay = owned(seen);
  const sample = first.accept(message(), 0)!;
  assert.equal(sample.tokensPerSecond, 3);
  assert.equal(sample.model, 'gpt-example');
  assert.equal(sample.estimatedTokens, 6);
  assert.equal(first.accept(message(), 0), null);
  assert.equal(replay.accept(message(), 0), null);
  assert.equal(JSON.stringify(sample).includes('123456'), false);
});
test('unowned, old and zero-duration task messages cannot yield a speed', () => {
  const unowned = new TaskOutput(text => text.length, 'codex', 'codex', 'owner');
  unowned.accept({ type: 'session_meta', payload: { creator_account_id: 'other' } }, 0);
  assert.equal(unowned.accept(message(), 0), null);
  assert.equal(owned().accept(message(), 4000), null);
  assert.equal(owned().accept(message('zero', 3000, 3000), 0)!.tokensPerSecond, null);
});
const claudeBlock = (uuid: string, at: number, type: string, thinkingDurationMs?: number, id = 'claude-response') => ({
  type: 'assistant', uuid, sessionId: 'claude-session', timestamp: new Date(at).toISOString(), thinkingDurationMs,
  message: { id, model: 'claude-example', content: [type === 'text' ? { type, text: '123456' } : { type }],
    usage: { output_tokens: 900, output_tokens_details: { thinking_tokens: 100 }, speed: 'standard' } } });
test('Claude speed spans the whole response from thinking start to its last block', () => {
  const parser = new TaskOutput(text => text.length, 'claude', 'claude'), average = new DialogSpeed();
  const thinking = parser.accept(claudeBlock('a', 3000, 'thinking', 2000), 0)!;
  assert.equal(thinking.kind, 'response');
  assert.equal(thinking.mode, 'standard');
  assert.equal(thinking.tokensPerSecond, 450);
  average.accept(thinking);
  parser.accept(claudeBlock('b', 3001, 'text'), 0);
  const last = parser.accept(claudeBlock('c', 10_000, 'tool_use'), 0)!;
  assert.equal(last.sampleId, thinking.sampleId);
  assert.equal(last.outputMs, 9000);
  assert.equal(last.tokensPerSecond, 100);
  assert.equal(parser.accept(claudeBlock('c', 10_000, 'tool_use'), 0), null);
  average.accept(last);
  const [reading] = average.readings(11_000, 3600_000);
  assert.equal(reading.responseSampleCount, 1);
  assert.equal(reading.responseTokensPerSecond, 100);
  assert.equal(reading.tokensPerSecond, 100);
  assert.equal(reading.excludedSamples, 0);
  const html = outputSpeed({ samples: [reading], stale: false }, 11_000);
  assert.ok(html.includes('整段输出'));
  assert.ok(html.includes('100.0'));
  assert.ok(!html.includes('思考 / 正文'));
  assert.ok(html.includes('speed-primary is-single'));
});
test('Claude responses without a timed leading thinking block stay unavailable', () => {
  const untimed = new TaskOutput(text => text.length, 'claude', 'claude').accept(claudeBlock('a', 3000, 'thinking'), 0)!;
  assert.equal(untimed.reason, 'missing_response_timing');
  assert.equal(untimed.outputMs, null);
  const textOnly = new TaskOutput(text => text.length, 'claude', 'claude').accept(claudeBlock('b', 3000, 'text'), 0)!;
  assert.equal(textOnly.tokensPerSecond, null);
  assert.equal(new TaskOutput(text => text.length, 'claude', 'claude').accept(claudeBlock('c', 3000, 'thinking', 2000), 2000)!.status, 'unavailable');
});
test('Fast settings survive tierless turn contexts and explicit Standard changes remain separate', () => {
  const parser = owned();
  assert.equal(parser.accept(message('unknown'), 0)!.mode, 'unknown');
  parser.accept({ type: 'event_msg', payload: { type: 'thread_settings_applied',
    thread_settings: { model: 'gpt-example', service_tier: 'priority' } } }, 0);
  parser.accept({ type: 'turn_context', payload: { model: 'gpt-example' } }, 0);
  const fast = parser.accept(message('fast'), 0)!;
  assert.equal(fast.mode, 'fast');
  assert.equal(fast.speedBasis, 'request');
  parser.accept({ type: 'turn_context', payload: { model: 'gpt-example', service_tier: 'default' } }, 0);
  const standard = parser.accept(message('standard'), 0)!;
  assert.equal(standard.mode, 'standard');
  assert.notEqual(sampleKey(fast), sampleKey(standard));
  assert.equal(normalizeMode('Recorded'), 'unknown');
  assert.equal(normalizeMode('Standard'), 'standard');
});
test('model cards show Fast configuration alongside a separately sampled Standard speed', () => {
  const fast = { ...owned().accept(message(), 0)!, mode: 'fast', speedBasis: 'request' };
  const standard = { ...fast, mode: 'standard', tokensPerSecond: 2, sampledAt: new Date(2000).toISOString() };
  const html = outputSpeed({ samples: [standard, fast], stale: false }, 3000);
  assert.ok(html.includes('Fast 开启'));
  assert.ok(html.includes('请求配置'));
  assert.ok(html.includes('≈3.0 token/s'));
  assert.ok(html.includes('≈2.0 token/s'));
  assert.equal(html.split('<h3>gpt-example</h3>').length - 1, 1);
  const unknown = outputSpeed({ samples: [{ ...fast, mode: 'unknown' }], stale: false }, 3000);
  assert.ok(unknown.includes('Fast 状态未知'));
});
test('speed cards follow each account in registry order and show the model it used most recently', () => {
  const base = owned().accept(message(), 0)!;
  const at = (account: string, model: string, sampledAt: number, tokensPerSecond: number) => ({ ...base, account, model,
    tokensPerSecond, status: 'sampled', sampledAt: new Date(sampledAt).toISOString() });
  const cards = (samples: any[], accounts?: { name: string; agent: string }[]) => [...outputSpeed({ samples, stale: false, accounts }, 5000)
    .matchAll(/<span>([^<]+) · 正在用<\/span>(?:<span[^>]*>[^<]*<\/span>)?<\/div>\s*<h3>([^<]+)<\/h3>/g)].map(match => `${match[1]}:${match[2]}`);
  const profile = (name: string) => ({ name, agent: name.startsWith('claude') ? 'claude' : 'codex' });
  const samples = [at('codex', 'gpt-6.1-sol', 4500, 1), at('claude', 'claude-haiku', 4000, 9), at('claude', 'claude-opus-5-5', 3000, 50),
    at('claude-3', 'claude-opus-5-5', 1000, 9)];
  const configured = ['claude', 'claude-2', 'claude-3', 'codex', 'codex-2'].map(profile);
  assert.deepEqual(cards(samples, configured), ['claude:claude-haiku', 'claude-2:近 1 小时无对话', 'claude-3:claude-opus-5-5', 'codex:gpt-6.1-sol',
    'codex-2:近 1 小时无对话']);
  assert.deepEqual(cards([...samples].reverse(), configured), cards(samples, configured));
  assert.deepEqual(cards(samples, ['claude-3', 'codex'].map(profile)), ['claude-3:claude-opus-5-5', 'codex:gpt-6.1-sol', 'claude:claude-haiku']);
  const html = outputSpeed({ samples, stale: false }, 5000);
  assert.ok(html.includes('<div class="speed-others"><span>近 1 小时其他模型</span><div><span>claude-opus-5-5</span><b>≈50.0 token/s</b></div></div>'));
});
test('speed cards carry the provider so values use its brand color', () => {
  const base = owned().accept(message(), 0)!;
  const html = outputSpeed({ samples: [{ ...base, account: 'claude-2', model: 'claude-opus-5-5', status: 'sampled' }], stale: false,
    accounts: [{ name: 'claude-2', agent: 'claude' }, { name: 'codex-2', agent: 'codex' }] }, 3000);
  assert.ok(html.includes('class="speed-card " data-provider="Claude"><div class="speed-meta"><span>claude-2 · 正在用</span>'));
  assert.ok(html.includes('data-provider="Codex"><div class="speed-meta"><span>codex-2 · 正在用</span></div><h3>近 1 小时无对话</h3>'));
});
test('sampled and stale readings never claim live streaming and model text is escaped', () => {
  const sample = { ...owned().accept(message(), 0)!, model: '<script>', source: 'task', status: 'sampled' };
  const fresh = outputSpeed({ samples: [sample], stale: false }, 3000);
  assert.ok(fresh.includes('≈3.0'));
  assert.ok(fresh.includes('&lt;script&gt;'));
  assert.equal(fresh.includes('is-streaming'), false);
  const stale = outputSpeed({ samples: [sample], stale: true }, 3000);
  assert.equal(stale.includes('≈3.0'), false);
  assert.ok(stale.includes('采集连接中断'));
});
test('recent conversations use token/time weighting, expire old samples and isolate modes and accounts', () => {
  const average = new DialogSpeed(), now = 7200_000;
  const sample = (sampleId: string, conversationId: string, measuredTokens: number, outputMs: number | null) => ({
    ...owned().accept(message(sampleId), 0)!, sampleId, conversationId, measuredTokens, outputMs,
    sampledAt: new Date(now - 1000).toISOString(), startedAt: outputMs ? new Date(now - 1000 - outputMs).toISOString() : null,
    mode: 'fast', kind: 'text' });
  average.accept(sample('short', 'private-conversation-1', 120, 1000));
  average.accept(sample('long', 'private-conversation-2', 900, 30_000));
  average.accept(sample('short', 'private-conversation-1', 120, 1000));
  average.accept(sample('missing', 'private-conversation-3', 100, null));
  average.accept({ ...sample('old', 'private-old', 999, 1000), sampledAt: new Date(now - 3600_001).toISOString() });
  average.accept({ ...sample('standard', 'private-conversation-1', 10, 1000), mode: 'standard' });
  average.accept({ ...sample('other-account', 'private-other', 20, 1000), account: 'codex-2' });
  const rows = average.readings(now), row = rows.find(row => row.mode === 'fast' && row.account === 'codex')!;
  assert.equal(row.tokensPerSecond, 1020 / 31);
  assert.equal(row.sampleCount, 2);
  assert.equal(row.conversationCount, 2);
  assert.equal(row.excludedSamples, 1);
  assert.equal(rows.length, 3);
  assert.equal(JSON.stringify(rows).includes('private-'), false);
  assert.deepEqual(average.readings(now + 3600_000), []);
});
test('reasoning uses reported response tokens and unions timed reasoning intervals without counting tool output', () => {
  const parser = owned(), seen = new Set<string>();
  const reasoning = (id: string, start: number, end: number) => ({ type: 'event_msg', payload: { type: 'item_completed',
    turn_id: 'turn', started_at_ms: start, completed_at_ms: end, item: { id, type: 'Reasoning', raw_content: 'private-thinking' } } });
  parser.accept(reasoning('r1', 1000, 4000), 0);
  parser.accept(reasoning('r1', 1000, 4000), 0);
  parser.accept(reasoning('r2', 3000, 5000), 0);
  const usage = { type: 'token_usage_record', timestamp: new Date(6000).toISOString(), payload: {
    turn_id: 'turn', response_id: 'response-1', usage: { output_tokens: 450, reasoning_output_tokens: 200 } } };
  const reason = parser.accept(usage, 0)!;
  assert.equal(reason.measuredTokens, 200);
  assert.equal(reason.outputMs, 4000);
  assert.equal(reason.tokensPerSecond, 50);
  assert.equal(parser.accept(usage, 0), null);
  const average = new DialogSpeed();
  average.accept(reason); average.accept(parser.accept(message('body', 5000, 7000), 0)!);
  const row = average.readings(7000)[0];
  assert.equal(row.measuredTokens, 206);
  assert.equal(row.tokensPerSecond, 206 / 6);
  assert.equal(row.reasoningTokensPerSecond, 50);
  assert.equal(row.outputTokensPerSecond, 3);
  const html = outputSpeed({ samples: [row], stale: false }, 7000);
  assert.ok(html.includes('<span>思考</span><strong>50.0</strong>'));
  assert.ok(html.includes('<span>输出</span><strong>3.0</strong>'));
  assert.equal(JSON.stringify(row).includes('private-thinking'), false);
  const a = owned(seen), b = owned(seen);
  a.accept(reasoning('shared', 1000, 5000), 0); b.accept(reasoning('shared', 1000, 5000), 0);
  assert.ok(a.accept(usage, 0)); assert.equal(b.accept(usage, 0), null);
});
test('rolling intervals retain history, weight tokens/time and exclude incomplete boundary segments', () => {
  const average = new DialogSpeed(), hour = 3600_000, now = 100 * hour;
  const add = (id: string, age: number, tokens: number, seconds: number, startAge?: number) => {
    const row = { ...owned().accept(message(id, now - age * hour - seconds * 1000, now - age * hour), 0)!,
      measuredTokens: tokens, mode: 'fast', conversationId: `private-${id}` };
    if (startAge) row.startedAt = new Date(now - startAge * hour).toISOString();
    average.accept(row); average.accept(row);
  };
  add('recent', 0.5, 100, 1); add('two', 2, 1000, 20); add('four', 4, 300, 10);
  add('day', 23, 200, 10); add('expired', 25, 9999, 1);
  assert.equal(average.readings(now)[0].sampleCount, 1);
  const windows = average.intervals(now);
  assert.deepEqual(windows.map(window => window.samples[0].sampleCount), [1, 2, 3, 4]);
  assert.deepEqual(windows.map(window => window.samples[0].tokensPerSecond), [100, 1100 / 21, 1400 / 31, 1600 / 41]);
  assert.equal(new Set(windows.map(window => window.end)).size, 1);
  assert.equal(JSON.stringify(windows).includes('private-'), false);
  add('boundary', 0.9, 50, 1, 1.1);
  const after = average.intervals(now);
  assert.equal(after[0].samples[0].sampleCount, 1);
  assert.equal(after[0].samples[0].excludedSamples, 1);
  assert.equal(after[1].samples[0].sampleCount, 3);
});
test('interval rendering isolates the selected account and mode and hides stale rates', () => {
  const average = new DialogSpeed();
  average.accept({ ...owned().accept(message(), 0)!, model: '<model>', mode: 'fast' });
  average.accept({ ...owned().accept(message('other'), 0)!, account: 'codex-2', model: 'private-other-model' });
  const snapshot = { intervals: average.intervals(3000), samples: [], stale: false };
  const html = intervalSpeed('codex', snapshot);
  assert.equal(html.includes('private-other-model'), false);
  assert.ok(html.includes('&lt;model&gt;'));
  assert.ok(html.includes('Fast'));
  assert.equal(html.split('≈3.0').length - 1, 8);
  assert.ok(html.includes('最近 24 小时'));
  assert.equal(intervalSpeed('codex', { ...snapshot, stale: true }).includes('≈3.0'), false);
});
test('task discovery backfills completed conversations older than the headline window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-interval-test-'));
  try {
    const path = join(dir, 'rollout.jsonl'), end = Date.now() - 3 * 3600_000;
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER, creator_account_id TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(path, Math.floor(end / 1000), 'owner'); db.close();
    writeFileSync(path, [
      { type: 'session_meta', payload: { creator_account_id: 'owner' } },
      { type: 'turn_context', payload: { model: 'gpt-example' } }, message('historical', end - 1000, end),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const average = new DialogSpeed();
    const watcher = new TaskWatch([{ agent: 'codex', name: 'codex', home: dir }], text => text.length,
      () => 'owner', sample => average.accept(sample));
    await watcher.discover(); await watcher.poll();
    assert.equal(average.readings().length, 0);
    assert.equal(average.intervals()[2].samples[0].outputTokensPerSecond, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('missing reasoning time and invalid usage are excluded without estimating hidden thinking text', () => {
  const parser = owned();
  const usage = { type: 'token_usage_record', timestamp: new Date(6000).toISOString(), payload: {
    turn_id: 'turn', response_id: 'missing-time', usage: { output_tokens: 450, reasoning_output_tokens: 200 } } };
  const row = parser.accept(usage, 0)!;
  assert.equal(row.outputMs, null);
  const average = new DialogSpeed(); average.accept(row);
  assert.equal(average.readings(6000)[0].tokensPerSecond, null);
  assert.equal(parser.accept({ ...usage, payload: { ...usage.payload, response_id: 'invalid',
    usage: { output_tokens: 100, reasoning_output_tokens: 200 } } }, 0), null);
  const html = outputSpeed({ samples: average.readings(6000), stale: false }, 6000);
  assert.ok(html.includes('不主动调用模型'));
  assert.equal(html.includes('下次兜底'), false);
  assert.equal(html.includes('≈'), false);
});
test('incremental task reads preserve a UTF-8 character split between writes without duplicate samples', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-speed-test-'));
  try {
    const path = join(dir, 'rollout.jsonl'), now = Date.now();
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER, creator_account_id TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(path, Math.floor(now / 1000), 'owner');
    db.close();
    const row = message('utf8', now - 1000, now);
    row.payload.item.content = [{ type: 'Text', text: '你好' }];
    const bytes = Buffer.from(JSON.stringify(row) + '\n'), split = bytes.indexOf(Buffer.from('你')) + 1;
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { creator_account_id: 'owner' } }) + '\n'
      + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-example' } }) + '\n');
    appendFileSync(path, bytes.subarray(0, split));
    const counted: string[] = [], samples: any[] = [];
    const watcher = new TaskWatch([{ agent: 'codex', name: 'codex', home: dir }], text => {
      counted.push(text); return text.length;
    }, () => 'owner', sample => samples.push(sample));
    await watcher.discover(); await watcher.poll();
    assert.equal(samples.length, 0);
    appendFileSync(path, bytes.subarray(split));
    await watcher.poll(); await watcher.poll();
    assert.deepEqual(counted, ['你好']);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].tokensPerSecond, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('profiles parse name, agent and home and reject unknown agents', () => {
  assert.deepEqual(parseProfiles('work:codex:/tmp/codex-home').map(({ name, agent, home }) => [name, agent, home]),
    [['work', 'codex', '/tmp/codex-home']]);
  assert.deepEqual(parseProfiles('').map(profile => profile.agent), ['claude', 'codex']);
  assert.throws(() => parseProfiles('x:gemini:/tmp'));
});
test('a Codex profile without a known owner counts every session in that profile', () => {
  const parser = new TaskOutput(text => text.length, 'codex', 'codex');
  parser.accept({ type: 'turn_context', payload: { model: 'gpt-example' } }, 0);
  assert.equal(parser.accept(message('any-owner'), 0)!.tokensPerSecond, 3);
});
