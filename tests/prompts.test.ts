import { beforeEach, afterEach, expect, test, vi } from 'vitest';

// Tests for src/lib/prompts.ts

beforeEach(() => {
  vi.resetModules();
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.OPENAI_MODEL;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unmock('openai');
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
});

test('summarizeLogToBug uses default model when OPENAI_MODEL missing', async () => {
  vi.mock('openai', () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    class OpenAIStub {
      chat = { completions: { create } };
      static createMock = create;
    }
    return { default: OpenAIStub };
  });
  const { summarizeLogToBug } = await import('../src/lib/prompts.ts');
  const result = await summarizeLogToBug([]);
  expect(result).toBe('ok');
  const { default: OpenAIStub }: any = await import('openai');
  expect(OpenAIStub.createMock).toHaveBeenCalledWith({ model: 'gpt-4o-mini', messages: expect.any(Array) });
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
