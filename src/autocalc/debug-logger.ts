/**
 * A simple debug logging system for autocalc processes.
 *
 * The engine is environment-agnostic: it never reads environment
 * variables or browser storage. Hosts opt into logging by calling setDebugLogLevels()
 * (or setting the globalThis.__AUTOCALC_LOG_LEVELS escape hatch, which is
 * read dynamically so levels can be toggled from a dev console without a
 * rebuild).
 */

let configuredLevels: Set<string> | null = null;

function parseLevels(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function setDebugLogLevels(levels: string | readonly string[] | null): void {
  if (levels === null) {
    configuredLevels = null;
    return;
  }

  configuredLevels = parseLevels(Array.isArray(levels) ? levels.join(',') : String(levels));
}

function getActiveLevels(): Set<string> {
  // A live global override wins so levels can be flipped at runtime from a dev console.
  const globalOverride = typeof globalThis !== 'undefined'
    ? (globalThis as any).__AUTOCALC_LOG_LEVELS
    : undefined;

  if (globalOverride !== undefined) {
    return parseLevels(String(globalOverride));
  }

  return configuredLevels ?? new Set();
}

export function debugLog(level: string, ...args: any[]): void {
  const levels = getActiveLevels();
  if (levels.has(level.toLowerCase()) || levels.has('*')) {
    // Style the tag nicely so it is visually distinct in dev console
    console.log(
      `%c[autocalc:${level}]%c`,
      'background: #1e293b; color: #38bdf8; font-weight: bold; padding: 1px 4px; border-radius: 3px;',
      '',
      ...args
    );
  }
}
