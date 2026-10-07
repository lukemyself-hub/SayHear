import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../../src/server-composition";
import { JournalCard } from "../journal-card";

export const dynamic = "force-dynamic";

/**
 * Journal module. This slice keeps the existing "latest current Journal" read
 * and the existing `JournalCard`; per-date browsing lands in #265.
 */
export default async function JournalsPage() {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/internal/journals");
  }

  const userId = asUserId(session.user.id);
  const [currentJournal, latestJournalNotice] = await Promise.all([
    composition.journalService.readLatest({ userId }),
    composition.journalService.readLatestGenerationNotice({ userId }),
  ]);

  return (
    <div className="portalPage">
      <JournalCard
        currentJournal={currentJournal}
        latestNotice={latestJournalNotice}
      />
    </div>
  );
}
