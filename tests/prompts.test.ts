import { beforeEach, expect, test, vi } from 'vitest';

// Tests for src/lib/prompts.ts model fallback

beforeEach(() => {
  vi.resetModules();
  delete process.env.OPENAI_MODEL;
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
