import { beforeEach, afterEach, expect, test, vi } from 'vitest';

// We vary mocks per test, so use doMock inside a helper:
function setup(opts: {
  // Input rows returned from SELECT ... IN
  rows?: Array<Record<string, any>>;
  // Failures to simulate
  delError?: Error | null;        // initial delete (duplicates)
  upsertReject?: Error | null;    // simulate upsert rejecting the promise
  upsertErrorProp?: Error | null; // simulate upsert resolving with { error }
  finalDelError?: Error | null;   // final cleanup delete
} = {}) {
  // Hold references so we can assert on call args later
  let selectIn!: ReturnType<typeof vi.fn>;
  let deleteIn!: ReturnType<typeof vi.fn>;
  let upsert!: ReturnType<typeof vi.fn>;
  let deleteEq!: ReturnType<typeof vi.fn>;

  // Lock mock
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));

  // Supabase client mock
  vi.doMock('@supabase/supabase-js', () => {
    selectIn = vi.fn().mockResolvedValue({
      data: opts.rows ?? [
        { id: '1', type: 'task', title: 'Task A', priority: 2, created: '2023-02-01' },
        { id: '1', type: 'task', title: 'Task A duplicate', priority: 5, created: '2023-02-02' },
        { id: '2', type: 'task', title: 'Task B', priority: 1, created: '2023-01-03' },
        { id: '3', type: 'task', title: 'Task C', priority: 1, created: '2023-01-01' },
        { id: '4', type: 'task', title: 'Task D', priority: 1, created: '2023-01-01' },
      ],
      error: null,
    });

    deleteIn = vi.fn().mockResolvedValue({ data: null, error: opts.delError ?? null });

    if (opts.upsertReject) {
      upsert = vi.fn().mockRejectedValue(opts.upsertReject);
    } else {
      upsert = vi.fn().mockResolvedValue({ data: null, error: opts.upsertErrorProp ?? null });
    }

    deleteEq = vi.fn().mockResolvedValue({ data: null, error: opts.finalDelError ?? null });

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

  return { selectIn: () => selectIn, deleteIn: () => deleteIn, upsert: () => upsert, deleteEq: () => deleteEq };
}

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = 'http://example.local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test('sorts and deduplicates roadmap items (happy path)', async () => {
  const m = setup(); // default rows include a duplicate id: '1'
  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');

  await normalizeRoadmap();

  // SELECT should ask for the types to normalize (task/new)
  expect(m.selectIn()).toHaveBeenCalledWith('type', ['task', 'new']);

  // Duplicates of id '1' should be deleted explicitly
  expect(m.deleteIn()).toHaveBeenCalledWith('id', ['1']);

  // Upsert should receive stable, re-prioritized items (1..n); adjust if your impl differs
  // We assert shape rather than exact array equality to be resilient to non-essential fields.
  const upsertCall = m.upsert().mock.calls[0];
  expect(upsertCall[1]).toEqual({ onConflict: 'id' });

  const upsertRows = upsertCall[0];
  // Expected order by your business rule: here we assume deterministic reorder by created/priority
  expect(upsertRows.map((r: any) => r.id)).toEqual(['3', '4', '2', '1']);
  expect(upsertRows.map((r: any) => r.type)).toEqual(['task', 'task', 'task', 'task']);
  expect(upsertRows.map((r: any) => r.priority)).toEqual([1, 2, 3, 4]);
});

test('propagates Supabase upsert rejection (promise rejects)', async () => {
  const m = setup({ upsertReject: new Error('boom') });
  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await expect(normalizeRoadmap()).rejects.toThrow('boom');
  // releaseLock is mocked; we could also assert it was called if exported here
});

test('throws when deleting duplicates fails', async () => {
  const delErr = new Error('dup del');
  setup({ delError: delErr });
  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await expect(normalizeRoadmap()).rejects.toThrow(delErr);
});

test('throws when upsert resolves with error property', async () => {
  const upErr = new Error('upsert');
  setup({ upsertErrorProp: upErr });
  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await expect(normalizeRoadmap()).rejects.toThrow(upErr);
});

test('throws when final delete fails', async () => {
  const finalErr = new Error('final del');
  setup({ finalDelError: finalErr });
  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await expect(normalizeRoadmap()).rejects.toThrow(finalErr);
});
