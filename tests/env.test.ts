import { beforeEach, afterEach, expect, test, vi } from 'vitest';

// Tests for src/lib/env.ts

beforeEach(() => {
  vi.resetModules();
  delete process.env.GH_USERNAME;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GH_USERNAME;
  delete process.env.EXAMPLE;
});

test('ENV provides default GH_USERNAME', async () => {
  const { ENV } = await import('../src/lib/env.ts');
  expect(ENV.GH_USERNAME).toBe('ai-dev-agent');
});

test('requireEnv throws on missing variable', async () => {
  const { requireEnv } = await import('../src/lib/env.ts');
  expect(() => requireEnv(['NOT_SET'])).toThrowError('Missing env: NOT_SET');
});

test('requireEnv succeeds when variable is set', async () => {
  process.env.EXAMPLE = '1';
  const { requireEnv } = await import('../src/lib/env.ts');
  expect(() => requireEnv(['EXAMPLE'])).not.toThrow();
});

