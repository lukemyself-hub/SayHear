import { createHash } from "node:crypto";

export type RequirementSource = Readonly<{
  kind:
    | "pull-request"
    | "issue"
    | "issue-comment"
    | "pull-request-comment"
    | "review-comment"
    | "review";
  id: number;
  parentNumber: number;
  authorId: number;
  authorLogin: string;
  authorType: "User" | "Bot";
  title: string | null;
  body: string;
  editedAt: string | null;
}>;

function compareSources(a: RequirementSource, b: RequirementSource): number {
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }
  if (a.parentNumber !== b.parentNumber) {
    return a.parentNumber < b.parentNumber ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

export function requirementSourceDigest(sources: readonly RequirementSource[]): string {
  const ordered = [...sources].sort(compareSources);
  const seen = new Set<string>();
  for (const source of ordered) {
    const identity = `${source.kind}|${source.parentNumber}|${source.id}`;
    if (seen.has(identity)) {
      throw new Error("requirement_source_duplicate");
    }
    seen.add(identity);
  }
  const canonical = ordered.map((source) => ({
    kind: source.kind,
    parentNumber: source.parentNumber,
    id: source.id,
    authorId: source.authorId,
    authorLogin: source.authorLogin,
    authorType: source.authorType,
    title: source.title,
    body: source.body,
    editedAt: source.editedAt,
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
