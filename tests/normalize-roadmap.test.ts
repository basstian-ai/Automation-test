import { beforeEach, afterEach, expect, test, vi } from 'vitest';

const data = [
  { id: '1', type: 'task', title: 'A', created_at: '2024-01-01' },
  { id: '1', type: 'task', title: 'A', created_at: '2024-01-01' },
];

function setup(opts: {
  delError?: Error | null;
  upsertError?: Error | null;
  finalDelError?: Error | null;
} = {}) {
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock('@supabase/supabase-js', () => {
    const selectIn = vi.fn().mockResolvedValue({ data, error: null });
    const deleteIn = vi.fn().mockResolvedValue({ error: opts.delError ?? null });
    const upsert = vi.fn().mockResolvedValue({ error: opts.upsertError ?? null });
    const deleteEq = vi.fn().mockResolvedValue({ error: opts.finalDelError ?? null });
    return {
      createClient: vi.fn(() => ({
        from: () => ({
          select: () => ({ in: selectIn }),
          delete: () => ({ in: deleteIn, eq: deleteEq }),
          upsert,
        }),
      })),
    };
  });
}

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = 'url';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key';
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test('throws when deleting duplicates fails', async () => {
  const delErr = new Error('dup del');
  setup({ delError: delErr });
  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await expect(normalizeRoadmap()).rejects.toThrow(delErr);
});

test('throws when upsert fails', async () => {
  const upsertErr = new Error('upsert');
  setup({ upsertError: upsertErr });
  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await expect(normalizeRoadmap()).rejects.toThrow(upsertErr);
});

test('throws when final delete fails', async () => {
  const finalErr = new Error('final del');
  setup({ finalDelError: finalErr });
  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await expect(normalizeRoadmap()).rejects.toThrow(finalErr);
});

