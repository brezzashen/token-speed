/** Renders passive interval speeds for the selected account, keeping models and modes separate from workload consumption. */
import type { SpeedSample, SpeedSnapshot } from './output-speed.ts';
import { escape, scopes, time } from './format.ts';
import { speedWindows } from '../dialog-speed.ts';
const modeName = (mode?: string) => mode === 'fast' ? 'Fast' : mode === 'standard' ? 'Standard'
  : mode === 'ultrafast' ? 'Ultrafast' : '模式未知';
export function intervalSpeed(account: string, snapshot?: SpeedSnapshot) {
  const rate = (value?: number | null) => !snapshot?.stale && value != null ? `≈${value.toFixed(1)}` : '—';
  const cells = (sample: SpeedSample) => `<td>${escape(sample.model)}</td><td>${modeName(sample.mode)}</td>
    <td>${rate(sample.outputTokensPerSecond)}</td><td>${rate(sample.reasoningTokensPerSecond)}</td><td class="accent">${rate(sample.tokensPerSecond)}</td>
    <td>${sample.conversationCount ?? 0} / ${sample.sampleCount ?? 0}${sample.excludedSamples ? `<span class="row-note">排除 ${sample.excludedSamples} 段</span>` : ''}</td>
    <td>${sample.sampleCount ? sample.measuredTokens.toLocaleString('zh-CN') : '—'}</td><td>${sample.outputMs ? `${(sample.outputMs / 1000).toFixed(2)}s` : '—'}</td>`;
  const rows = speedWindows.map(window => {
    const interval = snapshot?.intervals?.find(interval => interval.id === window.id);
    const label = `${scopes[window.id]}${interval ? `<span class="row-note">${time(interval.start)}<br>→ ${time(interval.end)}</span>` : ''}`;
    const samples = (interval?.samples ?? []).filter(sample => sample.account === account)
      .sort((a, b) => a.model.localeCompare(b.model) || String(a.mode).localeCompare(String(b.mode)));
    return samples.length ? samples.map(sample => `<tr><td>${label}</td>${cells(sample)}</tr>`).join('')
      : `<tr><td>${label}</td><td colspan="8" class="empty">${snapshot?.stale ? '采集连接中断' : '暂无有效对话测速数据'}</td></tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="interval-speed-table"><thead><tr><th>区间 / 本地时间</th><th>模型</th><th>模式</th><th>正文 token/s</th><th>思考 token/s</th><th>合并 token/s</th><th>有效对话 / 采样</th><th>有效生成 token</th><th>有效生成时长</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="table-note">${snapshot?.stale ? '采集连接中断，速度暂不显示。' : ''}平均速度 = 区间内有效生成 token 总数 ÷ 有效生成时长。只计完整生成段；思考使用记录计数，正文分词估算；Claude 记录只有整段回复时长，只计入合并列。工具等待不计，缺失或跨边界记录排除。区间重叠，不能相加。</p>`;
}
