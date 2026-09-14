import type { DriftReport } from '@ng-census/core';

/**
 * Drift output.
 *
 * Regressions only, by design. A CI gate that also prints what improved buries
 * the one line the reader needs to act on. Improvements are counted, not
 * listed.
 */
export function renderDrift(report: DriftReport): string {
  const lines: string[] = [''];

  for (const r of report.regressions) {
    lines.push(`  ✗ ${r.displayName.padEnd(22)} ${r.label.padEnd(24)} ${r.from} → ${r.to}`);
  }

  if (report.newEntityDebt.length > 0) {
    if (report.regressions.length > 0) lines.push('');
    lines.push('  New since baseline, already carrying legacy patterns:');
    for (const d of report.newEntityDebt) {
      lines.push(`  ✗ ${d.displayName.padEnd(22)} ${d.label.padEnd(24)} ${d.value}`);
    }
  }

  if (report.regressions.length > 0 || report.newEntityDebt.length > 0) lines.push('');

  const clean = report.unchangedCount;
  lines.push(`  ✓ ${clean} unchanged or improved`);
  if (report.improvements.length > 0) {
    lines.push(`  ✓ ${report.improvements.length} metric improvement(s)`);
  }
  if (report.removedEntities.length > 0) {
    lines.push(`  · ${report.removedEntities.length} entity(ies) removed since baseline`);
  }

  lines.push('');

  const total = report.regressions.length + report.newEntityDebt.length;
  lines.push(total === 0 ? '  No regressions.' : `  ${total} regression${total === 1 ? '' : 's'}. Exit 1.`);
  lines.push('');

  return lines.join('\n');
}
