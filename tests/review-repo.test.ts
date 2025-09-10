import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { ENV } from '../src/lib/env.js';

const envVars = {
  TARGET_OWNER: 'o',
  TARGET_REPO: 'r',
  SUPABASE_URL: 'https://supabase.local',
  SUPABASE_SERVICE_ROLE_KEY: 'key',
};

let saveState: ReturnType<typeof vi.fn>;
let reviewToIdeas: ReturnType<typeof vi.fn>;
let reviewToSummary: ReturnType<typeof vi.fn>;
let sbRequest: ReturnType<typeof vi.fn>;

const defaultIteratorImpl = () =>
  (async function* () {
    yield { data: [{ sha: '1234567', commit: { message: 'msg' } }] };
  })();

vi.mock('../src/lib/lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/github.js', () => ({
  gh: {
    rest: { repos: { listCommits: vi.fn() } },
    paginate: { iterator: vi.fn() },
  },
}));

vi.mock('../src/lib/prompts.js', () => {
  reviewToIdeas = vi.fn();
  reviewToSummary = vi.fn().mockResolvedValue('summary');
  return { reviewToSummary, reviewToIdeas };
});

vi.mock('../src/lib/state.js', () => {
  saveState = vi.fn();
  return {
    loadState: vi.fn().mockResolvedValue({ lastReviewedSha: 'old' }),
    saveState,
    appendChangelog: vi.fn(),
    appendDecision: vi.fn(),
  };
});

vi.mock('../src/lib/supabase.js', () => {
  sbRequest = vi.fn().mockResolvedValue([]);
  return { sbRequest };
});

beforeEach(async () => {
  vi.clearAllMocks();
  const { gh } = await import('../src/lib/github.js');
  gh.paginate.iterator.mockImplementation(defaultIteratorImpl);
  ENV.TARGET_OWNER = envVars.TARGET_OWNER;
  ENV.TARGET_REPO = envVars.TARGET_REPO;
  process.env.SUPABASE_URL = envVars.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  ENV.TARGET_OWNER = '';
  ENV.TARGET_REPO = '';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test('reviewRepo throws on invalid ideas YAML', async () => {
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  reviewToIdeas.mockResolvedValue('queue:\n  - id: 1\n    title: "Test');
  await expect(reviewRepo()).rejects.toThrow('Failed to parse ideas YAML');
  expect(saveState).not.toHaveBeenCalled();
});

test('reviewRepo throws when repo env vars are missing', async () => {
  ENV.TARGET_OWNER = '';
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  await expect(reviewRepo()).rejects.toThrow('Missing required TARGET_OWNER and TARGET_REPO environment variables');
});

test('reviewRepo batches ideas and generates unique IDs', async () => {
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  reviewToIdeas.mockResolvedValue(
    'queue:\n  - title: One\n    details: first\n  - title: Two\n    details: second\n',
  );
  await reviewRepo();
  const postCalls = sbRequest.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(postCalls).toHaveLength(2);
  const summaryBody = JSON.parse(postCalls[0][1].body);
  const ideasBody = JSON.parse(postCalls[1][1].body);
  expect(ideasBody).toHaveLength(2);
  const [first, second] = ideasBody;
  const uuidRegex = /^[0-9a-f-]{36}$/i;
  expect(first.id).toMatch(uuidRegex);
  expect(second.id).toMatch(uuidRegex);
  expect(first.id).not.toBe(second.id);
});

test('reviewRepo handles colons in fields', async () => {
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  reviewToIdeas.mockResolvedValue(
    'queue:\n  - title: Example\n    details: Includes colon: ok\n',
  );
  await reviewRepo();
  const postCalls = sbRequest.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(postCalls).toHaveLength(2);
  const ideasBody = JSON.parse(postCalls[1][1].body);
  expect(ideasBody[0].title).toBe('Example');
  expect(ideasBody[0].content).toBe('Includes colon: ok');
});

test('reviewRepo skips quoting YAML block scalars', async () => {
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  reviewToIdeas.mockResolvedValue(
    'queue:\n  - title: Example\n    details: |\n      first\n      second\n',
  );
  await reviewRepo();
  const postCalls = sbRequest.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(postCalls).toHaveLength(2);
  const ideasBody = JSON.parse(postCalls[1][1].body);
  expect(ideasBody[0].content).toBe('first\nsecond\n');
});

test('reviewRepo fetches bug roadmap items', async () => {
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  reviewToIdeas.mockResolvedValue('queue:\n');
  await reviewRepo();
  const paths = sbRequest.mock.calls.map((call) => call[0]);
  expect(paths).toContain('roadmap_items?select=content&type=eq.bug');
});

test('reviewRepo paginates commits beyond first page', async () => {
  const commits = [
    // first page: 10 commits
    { sha: 'sha12', commit: { message: 'm12' } },
    { sha: 'sha11', commit: { message: 'm11' } },
    { sha: 'sha10', commit: { message: 'm10' } },
    { sha: 'sha9', commit: { message: 'm9' } },
    { sha: 'sha8', commit: { message: 'm8' } },
    { sha: 'sha7', commit: { message: 'm7' } },
    { sha: 'sha6', commit: { message: 'm6' } },
    { sha: 'sha5', commit: { message: 'm5' } },
    { sha: 'sha4', commit: { message: 'm4' } },
    { sha: 'sha3', commit: { message: 'm3' } },
  ];
  const moreCommits = [
    { sha: 'sha2', commit: { message: 'm2' } },
    { sha: 'sha1', commit: { message: 'm1' } },
    { sha: 'old', commit: { message: 'old' } },
  ];
  const { gh } = await import('../src/lib/github.js');
  gh.paginate.iterator.mockImplementation(() =>
    (async function* () {
      yield { data: commits };
      yield { data: moreCommits };
    })(),
  );
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  reviewToIdeas.mockResolvedValue('queue:\n');
  await reviewRepo();
  const summaryInput = reviewToSummary.mock.calls[0][0];
  expect(summaryInput.commits).toHaveLength(12);
});

