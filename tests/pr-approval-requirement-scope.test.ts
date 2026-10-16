import { describe, expect, it } from "vitest";
import {
  requirementSourceDigest,
  type RequirementSource,
} from "../scripts/pr-approval/requirement-scope.ts";

const prSource: RequirementSource = {
  kind: "pull-request",
  id: 101,
  parentNumber: 362,
  authorId: 1,
  authorLogin: "alice",
  authorType: "User",
  title: "PR title",
  body: "PR body",
  editedAt: null,
};

const issueSource: RequirementSource = {
  kind: "issue",
  id: 7,
  parentNumber: 7,
  authorId: 2,
  authorLogin: "bob",
  authorType: "User",
  title: "Issue title",
  body: "Issue body",
  editedAt: null,
};

const commentSource: RequirementSource = {
  kind: "issue-comment",
  id: 9001,
  parentNumber: 7,
  authorId: 3,
  authorLogin: "carol",
  authorType: "User",
  title: null,
  body: "comment body",
  editedAt: null,
};

function sources(): RequirementSource[] {
  return [prSource, issueSource, commentSource];
}

describe("requirementSourceDigest", () => {
  it("hashes an empty collection to the known SHA256 of []", () => {
    expect(requirementSourceDigest([])).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
  });

  it("is stable under source reordering and does not mutate caller input", () => {
    const input = sources();
    const snapshot = [...input];
    const forward = requirementSourceDigest(input);
    const reordered = requirementSourceDigest([commentSource, prSource, issueSource]);
    const reversed = requirementSourceDigest([...input].reverse());
    expect(reordered).toBe(forward);
    expect(reversed).toBe(forward);
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(prSource);
    expect(input[1]).toBe(issueSource);
    expect(input[2]).toBe(commentSource);
  });

  it("changes when body, title, editedAt, or author fields change", () => {
    const base = requirementSourceDigest(sources());
    expect(
      requirementSourceDigest([
        prSource,
        issueSource,
        { ...commentSource, body: "edited comment body" },
      ]),
    ).not.toBe(base);
    expect(
      requirementSourceDigest([
        prSource,
        { ...issueSource, title: "Changed issue title" },
      ]),
    ).not.toBe(requirementSourceDigest([prSource, issueSource]));
    expect(
      requirementSourceDigest([
        prSource,
        { ...issueSource, editedAt: "2026-10-15T00:00:00.000Z" },
      ]),
    ).not.toBe(requirementSourceDigest([prSource, issueSource]));
    expect(
      requirementSourceDigest([
        prSource,
        { ...issueSource, authorLogin: "mallory" },
      ]),
    ).not.toBe(requirementSourceDigest([prSource, issueSource]));
    expect(
      requirementSourceDigest([
        prSource,
        { ...issueSource, authorId: 999 },
      ]),
    ).not.toBe(requirementSourceDigest([prSource, issueSource]));
    expect(
      requirementSourceDigest([
        prSource,
        { ...issueSource, authorType: "Bot" },
      ]),
    ).not.toBe(requirementSourceDigest([prSource, issueSource]));
  });

  it("changes when sources are added, removed, or a linked issue changes", () => {
    const base = requirementSourceDigest([prSource, issueSource]);
    expect(requirementSourceDigest([prSource, issueSource, commentSource])).not.toBe(base);
    expect(requirementSourceDigest([prSource])).not.toBe(base);
    expect(
      requirementSourceDigest([
        prSource,
        { ...issueSource, body: "linked issue edit" },
      ]),
    ).not.toBe(base);
    expect(
      requirementSourceDigest([
        prSource,
        { ...issueSource, title: "linked issue retitled" },
      ]),
    ).not.toBe(base);
  });

  it("rejects duplicate kind/parentNumber/id identities", () => {
    const duplicate: RequirementSource = {
      ...commentSource,
      body: "conflicting duplicate page",
    };
    expect(() => requirementSourceDigest([commentSource, duplicate])).toThrow();
    expect(() => requirementSourceDigest([commentSource, commentSource])).toThrow();
  });
});
