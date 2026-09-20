import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const REVIEW = "eval/continuation-acceptance-1a3b/run-v2/review";
const SOURCE = "/Users/lukemyself/Downloads/scores.json";

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function main(): Promise<void> {
  const [scoresText, pairsText, packageText, identitiesText] = await Promise.all([
    readFile(SOURCE, "utf8"),
    readFile(`${REVIEW}/pairs.json`, "utf8"),
    readFile(`${REVIEW}/review-package.json`, "utf8"),
    readFile(`${REVIEW}/sealed-identities.json`, "utf8"),
  ]);
  const scores = JSON.parse(scoresText);
  const identities = JSON.parse(identitiesText);
  let candidateWins = 0;
  let incumbentWins = 0;
  let ties = 0;
  for (const scenario of scores.scenarios) {
    if (scenario.overallChoice === "tie") {
      ties += 1;
      continue;
    }
    const winner = identities.mapping[scenario.scenarioId][scenario.overallChoice];
    if (winner === identities.arms.on) candidateWins += 1;
    else incumbentWins += 1;
  }
  await writeFile(`${REVIEW}/scores.json`, scoresText);
  await writeFile(
    `${REVIEW}/failed-review.json`,
    `${JSON.stringify(
      {
        version: "1a3b-g2-failed-review:v1",
        status: "failed",
        source: SOURCE,
        scoreSha256: hash(scoresText),
        pairsSha256: hash(pairsText),
        reviewPackageSha256: hash(packageText),
        sealedIdentitiesSha256: hash(identitiesText),
        scoredAt: scores.scoredAt,
        issueCommentScoredAt: "2026-09-20T16:46:45.448Z",
        provenanceNote:
          "The downloaded export and issue comment contain the same choices but different scoredAt values. The downloaded file is preserved byte-for-byte. Run v2 had no export-time package fingerprint.",
        result: { candidateWins, incumbentWins, ties, netPreference: candidateWins - incumbentWins },
      },
      null,
      2,
    )}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
