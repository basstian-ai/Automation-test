import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { ENV } from '../src/lib/env';

const envVars = {
  TARGET_OWNER: 'o',
  TARGET_REPO: 'r',
  SUPABASE_URL: 'https://supabase.local',
  SUPABASE_SERVICE_ROLE_KEY: 'key',
};

let saveState: ReturnType<typeof vi.fn>;
let reviewToIdeas: ReturnType<typeof vi.fn>;
let sbRequest: ReturnType<typeof vi.fn>;

vi.mock('../src/lib/lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/github.js', () => ({
  gh: {
    rest: {
      repos: {
        listCommits: vi.fn().mockResolvedValue({
          data: [{ sha: '1234567', commit: { message: 'msg' } }],
        }),
      },
    },
  },
}));

vi.mock('../src/lib/prompts.js', () => {
  reviewToIdeas = vi.fn();
  return {
    reviewToSummary: vi.fn().mockResolvedValue('summary'),
    reviewToIdeas,
  };
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


beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TARGET_OWNER', envVars.TARGET_OWNER);
  vi.stubEnv('TARGET_REPO', envVars.TARGET_REPO);
  vi.stubEnv('SUPABASE_URL', envVars.SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', envVars.SUPABASE_SERVICE_ROLE_KEY);
  ENV.TARGET_OWNER = envVars.TARGET_OWNER;
  ENV.TARGET_REPO = envVars.TARGET_REPO;
  ENV.SUPABASE_URL = envVars.SUPABASE_URL;
  ENV.SUPABASE_SERVICE_ROLE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  vi.unstubAllEnvs();
  ENV.TARGET_OWNER = '';
  ENV.TARGET_REPO = '';
  ENV.SUPABASE_URL = '';
  ENV.SUPABASE_SERVICE_ROLE_KEY = '';
});

test('reviewRepo throws on invalid ideas YAML', async () => {
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  reviewToIdeas.mockResolvedValue('queue:\n  - id: 1\n    title: "Test');
  await expect(reviewRepo()).rejects.toThrow('Failed to parse ideas YAML');
  expect(saveState).not.toHaveBeenCalled();
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
