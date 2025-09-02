import { beforeEach, afterEach, expect, test, vi } from 'vitest';

// Tests for src/lib/prompts.ts

beforeEach(() => {
  vi.resetModules();
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.OPENAI_MODEL;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
});

test('summarizeLogToBug throws when OPENAI_MODEL missing', async () => {
  const { summarizeLogToBug } = await import('../src/lib/prompts.ts');
  await expect(summarizeLogToBug([])).rejects.toThrowError('Missing env: OPENAI_MODEL');
});

test('getModel falls back to default when env is empty', async () => {
  const { getModel } = await import('../src/lib/prompts.ts');
  expect(getModel()).toBe('gpt-4o-mini');
});

test('getModel uses provided env model', async () => {
  process.env.OPENAI_MODEL = 'test-model';
  const { getModel } = await import('../src/lib/prompts.ts');
  expect(getModel()).toBe('test-model');
});
