import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ENV } from '../src/lib/env';

const SUPABASE_URL = 'https://example.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'service-key';

beforeEach(() => {
  ENV.SUPABASE_URL = SUPABASE_URL;
  ENV.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  ENV.SUPABASE_URL = '';
  ENV.SUPABASE_SERVICE_ROLE_KEY = '';
});

test('loadState fetches and returns data', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => '10' },
    json: async () => [{ data: { lastReviewedSha: 'abc' } }],
  } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { loadState } = await import('../src/lib/state.ts');
  const result = await loadState();

  expect(fetchMock).toHaveBeenCalledWith(
    `${SUPABASE_URL}/rest/v1/agent_state?select=data&limit=1`,
    expect.any(Object)
  );
  expect(result).toEqual({ lastReviewedSha: 'abc' });
});

test('saveState posts data to Supabase', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 204,
    headers: { get: () => '0' },
  } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { saveState } = await import('../src/lib/state.ts');
  await saveState({ lastReviewedSha: 'def' });

  expect(fetchMock).toHaveBeenCalledWith(
    `${SUPABASE_URL}/rest/v1/agent_state`,
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ id: 1, data: { lastReviewedSha: 'def' } }),
    })
  );
});

test('loadState throws when credentials missing', async () => {
  ENV.SUPABASE_URL = '';
  ENV.SUPABASE_SERVICE_ROLE_KEY = '';
  const { loadState } = await import('../src/lib/state.ts');
  await expect(loadState()).rejects.toThrow('Missing Supabase credentials');
});

