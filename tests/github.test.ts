import { beforeEach, afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TARGET_DIR;
  delete process.env.TARGET_OWNER;
  delete process.env.TARGET_REPO;
});

beforeEach(() => {
  vi.resetModules();
  delete process.env.TARGET_DIR;
  delete process.env.TARGET_OWNER;
  delete process.env.TARGET_REPO;
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

test('parseRepo handles owner/repo in TARGET_REPO', async () => {
  process.env.TARGET_REPO = 'basstian-ai/simple-pim-123';
  const { parseRepo } = await import('../src/lib/github.ts');
  expect(parseRepo()).toEqual({ owner: 'basstian-ai', repo: 'simple-pim-123' });
});

test('parseRepo handles separate TARGET_OWNER and TARGET_REPO', async () => {
  process.env.TARGET_OWNER = 'basstian-ai';
  process.env.TARGET_REPO = 'simple-pim-123';
  const { parseRepo } = await import('../src/lib/github.ts');
  expect(parseRepo()).toEqual({ owner: 'basstian-ai', repo: 'simple-pim-123' });
});

test('parseRepo throws if TARGET_REPO is missing', async () => {
  delete process.env.TARGET_OWNER;
  delete process.env.TARGET_REPO;
  const { parseRepo } = await import('../src/lib/github.ts');
  expect(() => parseRepo()).toThrow(
    'Invalid repo config. Got TARGET_OWNER="" TARGET_REPO="". Expected either TARGET_OWNER + TARGET_REPO or TARGET_REPO="owner/repo".'
  );
});