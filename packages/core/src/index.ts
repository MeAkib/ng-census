/**
 * The public surface of the analyzer.
 *
 * Everything a consumer needs — the CLI, an MCP server, a CI bot — comes from
 * here. Nothing in this package prints anything: it returns data, and the
 * caller decides how to show it. See `docs/ARCHITECTURE.md`.
 *
 * Start with `analyzeProject` in analyze.ts, and with `AnalysisResult` in
 * types.ts for the shape it returns.
 */
export * from './types.js';
export * from './version.js';
export * from './discover.js';
export * from './template.js';
export * from './config.js';
export * from './workspace.js';
export * from './baseline.js';
export * from './analyze.js';
export { analyzeClass } from './rules/class.js';
export { analyzeTemplate } from './rules/template.js';
export type { TemplateRuleResult } from './rules/template.js';
export type { ClassRuleResult } from './rules/class.js';
