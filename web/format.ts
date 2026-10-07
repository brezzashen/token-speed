/** Shared display rules for speed cards and interval tables. */
export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
export const scopes: Record<string, string> = { last_hour: '最近 1 小时', last_three_hours: '最近 3 小时', last_five_hours: '最近 5 小时', last_24_hours: '最近 24 小时' };
