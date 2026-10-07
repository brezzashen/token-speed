/** Browser rendering of aggregate speed readings; a client never starts provider requests. */
import { escape } from './format.ts';
import { outputSpeed, type SpeedSnapshot } from './output-speed.ts';
import { intervalSpeed } from './interval-speed.ts';
const element = (id: string) => document.getElementById(id)!;
const preference = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } };
let selected = preference('token-speed-account');
let fetching = false;
let snapshot: SpeedSnapshot = { samples: [], stale: false };

function render() {
  const names = [...new Set([...(snapshot.accounts ?? []).map(account => account.name), ...snapshot.samples.map(row => row.account)])];
  if (!names.includes(selected)) selected = names[0] ?? '';
  element('connection').textContent = snapshot.stale ? '连接中断' : '实时连接';
  document.body.dataset.connection = snapshot.stale ? 'unavailable' : 'live';
  element('output-speed').innerHTML = outputSpeed(snapshot);
  element('accounts').innerHTML = names.map(name => `<button data-account="${escape(name)}" aria-pressed="${name === selected}" class="${name === selected ? 'active' : ''}">${escape(name)}</button>`).join('');
  document.querySelectorAll<HTMLButtonElement>('[data-account]').forEach(button => button.onclick = () => {
    selected = button.dataset.account!;
    remember('token-speed-account', selected);
    render();
  });
  const panel = element('interval-speed');
  const scrollLeft = panel.querySelector('.table-scroll')?.scrollLeft ?? 0;
  panel.innerHTML = selected ? `<section class="panel"><div class="panel-title"><h2>区间速度对比 · ${escape(selected)}</h2><span>1 / 3 / 5 / 24 小时</span></div>${intervalSpeed(selected, snapshot)}</section>` : '';
  const table = panel.querySelector('.table-scroll');
  if (table) table.scrollLeft = scrollLeft;
}

async function sync() {
  if (fetching) return;
  fetching = true;
  try {
    const response = await fetch('/api/speed', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Speed read failed');
    snapshot = await response.json();
  } catch { snapshot = { ...snapshot, stale: true }; }
  finally { render(); fetching = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
setInterval(() => { if (!document.hidden) void sync(); }, 2000);
render();
void sync();
