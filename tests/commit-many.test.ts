import { describe, expect, it, vi } from "vitest";
import { commitMany, gh } from "../src/lib/github";
import { ENV } from "../src/lib/env";

describe("commitMany", () => {
  it("surfaces a descriptive error when git.createTree returns 404", async () => {
    process.env.PAT_TOKEN = "token";
    ENV.PAT_TOKEN = "token";
    ENV.TARGET_OWNER = "foo";
    ENV.TARGET_REPO = "bar";

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
});
