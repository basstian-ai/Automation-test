import { describe, expect, it, vi } from "vitest";
import { parseRepo } from "../src/env";
import { gh, getDefaultBranch } from "../src/lib/github";

describe("parseRepo", () => {
  it("parses separate TARGET_OWNER and TARGET_REPO", () => {
    process.env.TARGET_OWNER = "foo";
    process.env.TARGET_REPO = "bar";
    expect(parseRepo()).toEqual({ owner: "foo", repo: "bar" });
  });

  it("throws when missing TARGET_OWNER", () => {
    delete process.env.TARGET_OWNER;
    process.env.TARGET_REPO = "bar";
    expect(() => parseRepo()).toThrow("Missing required TARGET_OWNER and TARGET_REPO");
  });

  it("throws when missing TARGET_REPO", () => {
    process.env.TARGET_OWNER = "foo";
    delete process.env.TARGET_REPO;
    expect(() => parseRepo()).toThrow("Missing required TARGET_OWNER and TARGET_REPO");
  });

  it("throws when both missing", () => {
    delete process.env.TARGET_OWNER;
    delete process.env.TARGET_REPO;
    expect(() => parseRepo()).toThrow("Missing required TARGET_OWNER and TARGET_REPO");
  });
});

describe("Octokit integration", () => {
  it("passes owner and repo to API calls", async () => {
    process.env.TARGET_OWNER = "foo";
    process.env.TARGET_REPO = "bar";
    const spy = vi
      .spyOn(gh.rest.repos, "get")
      .mockResolvedValue({ data: { default_branch: "main" } } as any);
    await getDefaultBranch();
    expect(spy).toHaveBeenCalledWith({ owner: "foo", repo: "bar" });
  });
});
