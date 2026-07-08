import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The extraction-boundary guard: the engine must stay a pure, publishable
 * package. No React/Next/Supabase/IndexedDB imports, no imports reaching
 * outside the engine directory, and no environment or browser-storage reads.
 *
 * This is the executable form of the "Cross-Cutting: Future Public Engine
 * Boundary" rules in plans/full-refactor-plan.md.
 */

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

// Bare specifiers the engine (and its tests) may import.
const ALLOWED_BARE_IMPORTS = new Set(['zod', 'vitest']);
const ALLOWED_BARE_PREFIXES = ['node:'];

// Files allowed to break the rules, with the reason. Keep this list shrinking.
const EXCEPTIONS = new Map<string, string>([]);

const FORBIDDEN_TOKENS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /process\s*\.\s*env/, reason: 'environment variables are host concerns' },
  { pattern: /\blocalStorage\b/, reason: 'browser storage is a host concern' },
  { pattern: /\bsessionStorage\b/, reason: 'browser storage is a host concern' },
  { pattern: /\bindexedDB\b/, reason: 'IndexedDB is a host concern (inject a LayerCachePersistentBackend)' },
  { pattern: /\bdocument\s*\./, reason: 'DOM access is a host concern' },
];

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('engine purity', () => {
  const files = walkTsFiles(ENGINE_ROOT);

  it('finds engine sources to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const relPath = relative(ENGINE_ROOT, file).split(sep).join('/');
    if (EXCEPTIONS.has(relPath)) continue;

    it(`${relPath} stays within the engine boundary`, () => {
      const source = readFileSync(file, 'utf8');
      const violations: string[] = [];

      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith('.')) {
          const resolved = resolve(dirname(file), specifier);
          if (relative(ENGINE_ROOT, resolved).startsWith('..')) {
            violations.push(`relative import escapes the engine directory: '${specifier}'`);
          }
          continue;
        }

        if (ALLOWED_BARE_PREFIXES.some((prefix) => specifier.startsWith(prefix))) continue;
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!ALLOWED_BARE_IMPORTS.has(packageName)) {
          violations.push(`disallowed dependency: '${specifier}'`);
        }
      }

      const code = stripComments(source);
      for (const { pattern, reason } of FORBIDDEN_TOKENS) {
        if (pattern.test(code)) {
          violations.push(`forbidden token ${pattern} (${reason})`);
        }
      }

      expect(violations, violations.join('\n')).toEqual([]);
    });
  }
});
