/**
 * Guards against provider secrets or direct AI-provider calls leaking into the
 * browser bundle. The frontend must only ever talk to our own backend.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');
const ROOT = resolve(SRC, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css|html|json)$/.test(name)) out.push(p);
  }
  return out;
}

describe('secret hygiene', () => {
  const files = walk(SRC);

  it('scans a meaningful number of source files', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('contains no provider API keys or key-looking strings', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/nvapi-[A-Za-z0-9_-]{8,}/.test(text) || /\bsk-[A-Za-z0-9]{20,}\b/.test(text) || /AIza[0-9A-Za-z_-]{30,}/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('does not read AI credentials from VITE_ environment variables', () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => !x.includes('/test/'))) {
      const text = readFileSync(f, 'utf8');
      if (/import\.meta\.env\.VITE_[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/.test(text) || /VITE_AI_/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('never calls an AI provider directly from the browser', () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => !x.includes('/test/'))) {
      const text = readFileSync(f, 'utf8');
      if (/integrate\.api\.nvidia\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com/.test(text)) offenders.push(f);
      if (/fetch\(\s*['"`]https?:\/\//.test(text)) offenders.push(`${f} (absolute fetch)`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the session token out of localStorage', () => {
    const client = readFileSync(join(SRC, 'api', 'client.ts'), 'utf8');
    expect(client).not.toMatch(/localStorage\.setItem\([^)]*token/i);
    expect(client).toMatch(/sessionStorage/);
  });

  it('backend .env is git-ignored and .env.example only has placeholders', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\s*(backend\/)?\.env\s*$/m);
    const example = readFileSync(join(ROOT, 'backend', '.env.example'), 'utf8');
    expect(example).toMatch(/^AI_API_KEY=/m);
    expect(example).not.toMatch(/nvapi-[A-Za-z0-9_-]{8,}/);
    if (existsSync(join(ROOT, 'frontend', '.env'))) {
      expect(readFileSync(join(ROOT, 'frontend', '.env'), 'utf8')).not.toMatch(/KEY|SECRET|nvapi/);
    }
  });
});
