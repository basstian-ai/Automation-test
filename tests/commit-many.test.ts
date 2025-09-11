import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitMany, gh } from "../src/lib/github";
import { ENV } from "../src/lib/env";

describe("commitMany", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.TARGET_DIR = "";
    ENV.TARGET_DIR = "";
  });

  it("surfaces a descriptive error when git.createTree returns 404", async () => {
    process.env.PAT_TOKEN = "token";
    ENV.PAT_TOKEN = "token";
    ENV.TARGET_OWNER = "foo";
    ENV.TARGET_REPO = "bar";

    vi.spyOn(gh, "request").mockResolvedValue({
      headers: { "x-oauth-scopes": "repo" }
    } as any);

    vi.spyOn(gh.rest.git, "getRef").mockResolvedValue({
      data: { object: { sha: "headsha" } }
    } as any);
    vi.spyOn(gh.rest.git, "getCommit").mockResolvedValue({
      data: { tree: { sha: "treesha" } }
    } as any);
    vi.spyOn(gh.rest.git, "getTree").mockResolvedValue({ data: { tree: [] } } as any);
    vi.spyOn(gh.rest.git, "createBlob").mockResolvedValue({ data: { sha: "blobsha" } } as any);
    vi.spyOn(gh.rest.repos, "get").mockResolvedValue({} as any);

    const createTreeMock = vi
      .spyOn(gh.rest.git, "createTree")
      .mockRejectedValue({ status: 404, message: "Not Found" });

    await expect(
      commitMany([{ path: "file.txt", content: "hello" }], "msg", { branch: "main" })
    ).rejects.toThrow(
      "Access to repository foo/bar failed with status 404. Please verify TARGET_OWNER, TARGET_REPO, and PAT_TOKEN permissions."
    );

    expect(createTreeMock).toHaveBeenCalled();
  });

  it("handles file deletions", async () => {
    process.env.PAT_TOKEN = "token";
    ENV.PAT_TOKEN = "token";
    ENV.TARGET_OWNER = "foo";
    ENV.TARGET_REPO = "bar";

    vi.spyOn(gh, "request").mockResolvedValue({
      headers: { "x-oauth-scopes": "repo" }
    } as any);

    vi.spyOn(gh.rest.git, "getRef").mockResolvedValue({
      data: { object: { sha: "headsha" } }
    } as any);
    vi.spyOn(gh.rest.git, "getCommit").mockResolvedValue({
      data: { tree: { sha: "treesha" } }
    } as any);
    vi.spyOn(gh.rest.git, "getTree").mockResolvedValue({ data: { tree: [] } } as any);
    const createBlob = vi
      .spyOn(gh.rest.git, "createBlob")
      .mockResolvedValue({ data: { sha: "blobsha" } } as any);
    vi.spyOn(gh.rest.repos, "get").mockResolvedValue({} as any);

    const createTree = vi
      .spyOn(gh.rest.git, "createTree")
      .mockResolvedValue({ data: { sha: "newtree" } } as any);
    vi.spyOn(gh.rest.git, "createCommit").mockResolvedValue({ data: { sha: "newcommit" } } as any);
    vi.spyOn(gh.rest.git, "updateRef").mockResolvedValue({} as any);

    await commitMany(
      [
        { path: "keep.txt", content: "hi" },
        { path: "remove.txt", sha: null, mode: "100644" }
      ],
      "msg",
      { branch: "main" }
    );

    expect(createBlob).toHaveBeenCalledTimes(1);
    expect(createTree).toHaveBeenCalledWith({
      owner: "foo",
      repo: "bar",
      base_tree: "treesha",
      tree: [
        { path: "main/keep.txt", mode: "100644", type: "blob", sha: "blobsha" },
        { path: "main/remove.txt", mode: "100644", type: "blob", sha: null }
      ]
    });
  });

  it("does not prefix default branch when branch option is omitted", async () => {
    process.env.PAT_TOKEN = "token";
    ENV.PAT_TOKEN = "token";
    ENV.TARGET_OWNER = "foo";
    ENV.TARGET_REPO = "bar";

    vi.spyOn(gh, "request").mockResolvedValue({
      headers: { "x-oauth-scopes": "repo" }
    } as any);

    vi.spyOn(gh.rest.git, "getRef").mockResolvedValue({
      data: { object: { sha: "headsha" } }
    } as any);
    vi.spyOn(gh.rest.git, "getCommit").mockResolvedValue({
      data: { tree: { sha: "treesha" } }
    } as any);
    vi.spyOn(gh.rest.git, "getTree").mockResolvedValue({ data: { tree: [] } } as any);
    const createBlob = vi
      .spyOn(gh.rest.git, "createBlob")
      .mockResolvedValue({ data: { sha: "blobsha" } } as any);
    const reposGet = vi.spyOn(gh.rest.repos, "get");
    reposGet
      .mockResolvedValueOnce({} as any)
      .mockResolvedValueOnce({ data: { default_branch: "main" } } as any);

    const createTree = vi
      .spyOn(gh.rest.git, "createTree")
      .mockResolvedValue({ data: { sha: "newtree" } } as any);
    vi.spyOn(gh.rest.git, "createCommit").mockResolvedValue({ data: { sha: "newcommit" } } as any);
    vi.spyOn(gh.rest.git, "updateRef").mockResolvedValue({} as any);

    await commitMany([{ path: "foo.txt", content: "hi" }], "msg");

    expect(createBlob).toHaveBeenCalledTimes(1);
    expect(createTree).toHaveBeenCalledWith({
      owner: "foo",
      repo: "bar",
      base_tree: "treesha",
      tree: [
        { path: "foo.txt", mode: "100644", type: "blob", sha: "blobsha" }
      ]
    });
  });

  it("fails fast when repo access check fails", async () => {
    process.env.PAT_TOKEN = "token";
    ENV.PAT_TOKEN = "token";
    ENV.TARGET_OWNER = "foo";
    ENV.TARGET_REPO = "bar";

    vi.spyOn(gh, "request").mockResolvedValue({
      headers: { "x-oauth-scopes": "repo" }
    } as any);

    const reposGet = vi
      .spyOn(gh.rest.repos, "get")
      .mockRejectedValue({ status: 404 });
    const createBlob = vi.spyOn(gh.rest.git, "createBlob");

    await expect(
      commitMany([{ path: "file.txt", content: "hi" }], "msg")
    ).rejects.toThrow(
      "Access to repository foo/bar failed with status 404. Please verify TARGET_OWNER, TARGET_REPO, and PAT_TOKEN permissions."
    );

    expect(createBlob).not.toHaveBeenCalled();
    expect(reposGet).toHaveBeenCalled();
  });

  it("throws when PAT_TOKEN lacks repo scope", async () => {
    process.env.PAT_TOKEN = "token";
    ENV.PAT_TOKEN = "token";
    ENV.TARGET_OWNER = "foo";
    ENV.TARGET_REPO = "bar";

    const reqMock = vi
      .spyOn(gh, "request")
      .mockResolvedValue({ headers: { "x-oauth-scopes": "read:user" } } as any);
    const reposGet = vi.spyOn(gh.rest.repos, "get");

    await expect(
      commitMany([{ path: "f.txt", content: "hi" }], "msg")
    ).rejects.toThrow("PAT_TOKEN is missing required repo scope");

    expect(reqMock).toHaveBeenCalled();
    expect(reposGet).not.toHaveBeenCalled();
  });
});
