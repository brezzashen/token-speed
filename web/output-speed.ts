/** First-screen cards show each account's most recently used model with its rolling conversation-weighted rates and sample coverage. */
import { escape, time } from './format.ts';
import { normalizeMode } from '../speed-policy.ts';
export type SpeedSample = { model: string; account: string; source: string; status: string; reason: string | null;
  mode?: string; speedBasis?: string;
  sampleCount?: number; conversationCount?: number; outputSampleCount?: number; reasoningSampleCount?: number; excludedSamples?: number;
  responseSampleCount?: number; responseTokensPerSecond?: number | null;
  outputTokensPerSecond?: number | null; reasoningTokensPerSecond?: number | null;
  sampledAt: string; updatedAt: string; tokensPerSecond: number | null; estimatedTokens: number; measuredTokens: number;
  outputMs: number | null; firstTextMs: number | null };
export type SpeedInterval = { id: string; windowMs: number; start: string; end: string; samples: SpeedSample[] };
export type SpeedAccount = { name: string; agent: string };
export type SpeedSnapshot = { samples: SpeedSample[]; stale: boolean; intervals?: SpeedInterval[]; accounts?: SpeedAccount[] };
// One card per configured profile in configuration order, then other recorded accounts by name. Each card follows the
// model the account answered with most recently; speed never moves a card.
const rateCells = (cells: [string, number | null | undefined, string][]) => `<div class="speed-primary${cells.length === 1 ? ' is-single' : ''}">${cells
  .map(([label, value, unit]) => `<div><span>${label}</span><strong>${typeof value === 'number' ? value.toFixed(1) : '—'}</strong><small>${unit}</small></div>`).join('')}</div>`;
const primaryRates = (reasoning?: number | null, output?: number | null) => rateCells([['思考', reasoning, 'token/s'], ['输出', output, 'token/s']]);
// Claude records time only the whole response, so its card shows one whole-response rate and no thinking cell.
const responseRates = (response?: number | null) => rateCells([['整段输出', response, '含思考 · token/s']]);
// Speed numbers take the provider brand color: Claude models orange-red, GPT models white.
const providerOf = (model: string) => model.startsWith('claude') ? 'Claude' : model.startsWith('gpt') ? 'Codex' : '';
export function outputSpeed(snapshot: SpeedSnapshot, now = Date.now()) {
  const available = (row: SpeedSample) => !snapshot.stale && now - Date.parse(row.sampledAt) <= 3600_000
    && row.tokensPerSecond !== null;
  const rows = [...snapshot.samples].sort((a, b) => Number(available(b)) - Number(available(a))
    || Date.parse(b.sampledAt) - Date.parse(a.sampledAt));
  const configured = snapshot.accounts ?? [];
  const agents = new Map(configured.map(account => [account.name, account.agent]));
  const accountProvider = (account: string) => agents.get(account) === 'claude' ? 'Claude' : agents.get(account) === 'codex' ? 'Codex' : '';
  const accounts = [...configured.map(account => account.name),
    ...[...new Set(rows.map(row => row.account))].filter(account => !agents.has(account)).sort()];
  const modeLabel = (mode: string) => mode === 'fast' ? 'Fast 开启' : mode === 'standard' ? 'Fast 未开启 · Standard'
    : mode === 'ultrafast' ? 'Ultrafast 开启' : 'Fast 状态未知';
  const cards = accounts.map(account => {
    const owned = rows.filter(row => row.account === account);
    const latest = [...owned].sort((a, b) => Number(available(b)) - Number(available(a))
      || Date.parse(b.sampledAt) - Date.parse(a.sampledAt))[0];
    if (!latest) return `<article class="speed-card" data-provider="${accountProvider(account)}"><div class="speed-meta"><span>${escape(account)} · 正在用</span></div><h3>近 1 小时无对话</h3><div class="speed-mode">Fast 状态未知</div>${primaryRates()}<div class="speed-detail">没有有效对话数据</div></article>`;
    const model = latest.model, group = owned.filter(row => row.model === model);
    const row = normalizeMode(latest.mode) !== 'unknown' ? latest
      : group.find(row => available(row) && normalizeMode(row.mode) !== 'unknown') ?? latest;
    const others = [...new Set(owned.map(row => row.model))].filter(other => other !== model).sort().map(other => {
      const sample = owned.filter(row => row.model === other).find(available);
      return `<div><span>${escape(other)}</span><b>${sample ? `≈${sample.tokensPerSecond!.toFixed(1)} token/s` : '—'}</b></div>`;
    }).join('');
    const expired = now - Date.parse(row.sampledAt) > 3600_000;
    const live = !snapshot.stale && !expired && ['streaming', 'waiting'].includes(row.status);
    const mode = normalizeMode(row.mode);
    const state = snapshot.stale ? '采集连接中断' : expired ? '采样已过期' : row.status === 'streaming' ? '正在输出'
      : row.status === 'waiting' ? '等待首字' : row.status === 'unavailable' ? '缺少有效时间记录'
      : '最近 1 小时均值';
    const rate = (value: number | null | undefined) => available(row) && value != null ? `≈${value.toFixed(1)}` : '—';
    return `<article class="speed-card ${live ? 'is-streaming' : ''}" data-provider="${providerOf(model)}"><div class="speed-meta"><span>${escape(account)} · 正在用</span><span class="speed-state">${state}</span></div>
      <h3>${escape(row.model)}</h3><div class="speed-mode ${mode === 'fast' ? 'is-fast' : ''}">${modeLabel(mode)}<span>${mode === 'unknown' ? '缺少模式记录' : row.speedBasis === 'response' ? '响应记录' : row.speedBasis === 'mixed' ? '混合记录' : '请求配置'}</span></div>
      ${row.responseSampleCount ? responseRates(available(row) ? row.responseTokensPerSecond : null)
        : primaryRates(available(row) ? row.reasoningTokensPerSecond : null, available(row) ? row.outputTokensPerSecond : null)}
      <div class="speed-mean"><span>合并均值</span><b>${rate(row.tokensPerSecond)}</b><small>token/s</small></div>
      <div class="speed-detail">${row.status === 'unavailable' ? '已有对话 · 缺少有效生成时间' : `${row.conversationCount ?? 0} 个对话 · ${row.sampleCount ?? 0} 个有效采样`}
      ${row.outputMs !== null ? `<br>${row.measuredTokens} token / ${(row.outputMs / 1000).toFixed(2)}s 生成` : ''}
      ${row.sampleCount !== undefined ? `<br>${row.responseSampleCount ? `整段回复 ${row.responseSampleCount} 段` : `思考 ${row.reasoningSampleCount ?? 0} 段 · 输出 ${row.outputSampleCount ?? 0} 段`}${row.excludedSamples ? ` · 排除 ${row.excludedSamples} 段` : ''}` : ''}</div>
      <div class="speed-time">${time(row.sampledAt)}${row.firstTextMs !== null ? ` · 首字 ${(row.firstTextMs / 1000).toFixed(1)}s` : ''}</div>
      <div class="speed-comparison">${['fast', 'standard'].map(mode => {
        const sample = group.find(sample => normalizeMode(sample.mode) === mode);
        const value = sample && available(sample) ? `≈${sample.tokensPerSecond!.toFixed(1)} token/s` : '—';
        const source = !sample ? '暂无有效对话数据' : snapshot.stale ? '连接中断'
          : now - Date.parse(sample.sampledAt) > 3600_000 ? '采样过期' : sample.status === 'streaming' ? '正在输出'
          : `${sample.conversationCount ?? 0} 对话 / ${sample.sampleCount ?? 0} 采样`;
        return `<div><span>${mode === 'fast' ? 'Fast' : 'Standard'}</span><b>${value}</b><small>${source}</small></div>`;
      }).join('')}</div>${others ? `<div class="speed-others"><span>近 1 小时其他模型</span>${others}</div>` : ''}</article>`;
  }).join('');
  return `<section class="panel output-speed"><div class="panel-title"><h2>各账号当前输出速度</h2><span>最近 1 小时 / 只读本机对话记录</span></div><div class="speed-grid">${cards}</div>
    <p class="table-note speed-note">总 token ÷ 总生成时长 · 思考使用记录计数，输出分词估算 · Claude 按整段回复计（含思考，记录无法拆分） · 仅计完整生成段 · 工具等待不计 · 每 2 秒采集
    <span>仅采集已有对话 · 不主动调用模型</span></p></section>`;
}
