import { estimateCost } from '../../core/models.js';
import type { TokenUsage } from '../../shared/types.js';

/** "42s", "3m 05s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function formatCost(dollars: number): string {
  if (dollars < 0.01) return 'under 1¢';
  return `about $${dollars.toFixed(2)}`;
}

/**
 * One line on what a generation took: time, output tokens (and how many of
 * them were reasoning), and roughly what it cost. Parts that were not
 * reported are left out.
 */
export function describeUsage(model: string | null, usage: TokenUsage | null | undefined, elapsedMs?: number): string {
  const parts: string[] = [];
  if (elapsedMs !== undefined) parts.push(formatDuration(elapsedMs));
  if (usage) {
    parts.push(
      `${usage.output.toLocaleString()} tokens out` +
        (usage.thinking > 0 ? ` (${usage.thinking.toLocaleString()} reasoning)` : '') +
        `, ${(usage.input + usage.cacheRead).toLocaleString()} in`,
    );
    const cost = estimateCost(model, usage);
    if (cost !== null) parts.push(formatCost(cost));
  }
  return parts.join(' · ');
}
