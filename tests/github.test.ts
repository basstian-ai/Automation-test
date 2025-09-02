import { beforeEach, afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TARGET_DIR;
});

beforeEach(() => {
  vi.resetModules();
  delete process.env.TARGET_DIR;
});

test('normalizes mixed path separators', async () => {
  const { resolveRepoPath } = await import('../src/lib/github.ts');
  const resolved = resolveRepoPath('foo\\bar/baz\\qux.txt');
  expect(resolved).toBe('foo/bar/baz/qux.txt');
});

test('rejects paths containing ..', async () => {
  const { resolveRepoPath } = await import('../src/lib/github.ts');
  expect(() => resolveRepoPath('../secret')).toThrow('Refusing path outside repo: ../secret');
});

test('rejects empty paths', async () => {
  const { resolveRepoPath } = await import('../src/lib/github.ts');
  expect(() => resolveRepoPath('')).toThrow('Empty path');
});

test('prefixes TARGET_DIR when set', async () => {
  process.env.TARGET_DIR = 'base';
  const { resolveRepoPath } = await import('../src/lib/github.ts');
  const resolved = resolveRepoPath('file.txt');
  expect(resolved).toBe('base/file.txt');
});
