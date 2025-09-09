import { beforeEach, afterEach, expect, test, vi } from 'vitest';
let ENV: any;

// Tests for resolveRepoPath in src/lib/github.ts

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('TARGET_DIR', '');
  ({ ENV } = await import('../src/lib/env.ts'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (ENV) ENV.TARGET_DIR = '';
});

test('normalizes forward and back slashes', async () => {
  const { resolveRepoPath } = await import('../src/lib/github.ts');
  expect(resolveRepoPath('\\foo\\bar/baz.ts')).toBe('foo/bar/baz.ts');
});

test('rejects paths escaping the repo', async () => {
  const { resolveRepoPath } = await import('../src/lib/github.ts');
  expect(() => resolveRepoPath('../secret')).toThrowError(
    'Refusing path outside repo: ../secret'
  );
});

test('applies TARGET_DIR prefix', async () => {
  vi.stubEnv('TARGET_DIR', '/nested/dir/');
  ENV.TARGET_DIR = '/nested/dir/';
  const { resolveRepoPath } = await import('../src/lib/github.ts');
  expect(resolveRepoPath('file.txt')).toBe('nested/dir/file.txt');
});
