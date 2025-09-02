import { beforeEach, afterEach, expect, test, vi } from 'vitest';

// Tests for resolveRepoPath in src/lib/github.ts

beforeEach(() => {
  vi.resetModules();
  delete process.env.TARGET_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TARGET_DIR;
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
  process.env.TARGET_DIR = '/nested/dir/';
  const { resolveRepoPath } = await import('../src/lib/github.ts');
  expect(resolveRepoPath('file.txt')).toBe('nested/dir/file.txt');
});
