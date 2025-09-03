import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const SUPABASE_URL = 'https://example.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'service-key';

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test('sbRequest error surfaces message and hint', async () => {
  const body = { message: 'bad thing', hint: 'do better' };
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => JSON.stringify(body),
  } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { sbRequest } = await import('../src/lib/supabase.ts');
  await expect(sbRequest('test')).rejects.toThrow(`${body.message} - ${body.hint}`);
});

