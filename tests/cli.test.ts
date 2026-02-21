/**
 * Tests for CLI
 *
 * cli.ts uses Commander and calls program.parse(process.argv) at the module
 * level, making direct import in unit tests problematic. These tests verify
 * the module structure and that the CLI binary is correctly registered.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

describe('CLI', () => {
  it('cli.ts source file exists', () => {
    expect(existsSync(join(ROOT, 'src/cli.ts'))).toBe(true);
  });

  it('cli binary is registered in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.bin).toBeDefined();
    const binValues = Object.values(pkg.bin as Record<string, string>);
    expect(binValues.some(b => b.includes('cli'))).toBe(true);
  });

  it('cli.ts exports nothing (command-only module)', async () => {
    // cli.ts has no exports — verify by checking the source does not start with export
    const src = readFileSync(join(ROOT, 'src/cli.ts'), 'utf-8');
    const topLevelExports = src.match(/^export\s+(const|function|class|default)/m);
    expect(topLevelExports).toBeNull();
  });

  it('cli.ts uses Commander for command parsing', () => {
    const src = readFileSync(join(ROOT, 'src/cli.ts'), 'utf-8');
    expect(src).toContain("from 'commander'");
    expect(src).toContain('program.parse');
  });
});
