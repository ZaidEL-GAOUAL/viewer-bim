/** Counts reported by the provider. Null means unavailable, never zero or an estimate. */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeUsage(raw: unknown): TokenUsage {
  const usage = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const inputTokens = count(usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = count(usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens);
  const reported = count(usage.totalTokens ?? usage.total_tokens);
  // Adding two measured counters is exact. Never infer missing counters from text length.
  const totalTokens = reported ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, totalTokens };
}

export class SessionUsage {
  calls = 0;
  readonly totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  readonly missing = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  add(raw: unknown): void {
    const usage = normalizeUsage(raw);
    this.calls++;
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
      if (usage[key] === null) this.missing[key]++;
      else this.totals[key] += usage[key];
    }
  }

  display(key: keyof TokenUsage): string {
    if (this.missing[key] === this.calls && this.calls > 0) return '?';
    return this.totals[key].toLocaleString('fr-FR') + (this.missing[key] ? ' + ?' : '');
  }
}
