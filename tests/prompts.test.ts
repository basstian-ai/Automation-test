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
