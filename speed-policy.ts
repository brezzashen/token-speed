/** Normalizes recorded service tiers and separates model/mode cohorts; speed.test.ts protects both. */
export function normalizeMode(mode: unknown) {
  const value = typeof mode === 'string' ? mode.toLowerCase() : '';
  return ['default', 'standard'].includes(value) ? 'standard' : ['priority', 'fast'].includes(value) ? 'fast'
    : value === 'ultrafast' ? 'ultrafast' : 'unknown';
}
export const sampleKey = (sample: { model: string; mode?: string }) => `${sample.model}|${normalizeMode(sample.mode)}`;
