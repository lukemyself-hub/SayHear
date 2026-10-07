import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../../src/server-composition";
import { JournalView } from "../journal-card";

export const dynamic = "force-dynamic";

type JournalsPageProps = Readonly<{
  searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}>;

const LOGICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isSelectableDate(value: string): boolean {
  if (!LOGICAL_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Journal module. The selected date comes from `?date=YYYY-MM-DD`; without one
 * the latest current published Journal is selected. Every read is owner-scoped
 * and gated; a day with no readable Journal renders an explicit empty state
 * rather than a fabricated entry.
 */
export default async function JournalsPage(props: JournalsPageProps) {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/internal/journals");
  }

  const userId = asUserId(session.user.id);
  const searchParams = await props.searchParams;
  const requestedDate = searchParams.date;
  const logicalDate =
    typeof requestedDate === "string" && isSelectableDate(requestedDate)
      ? requestedDate
      : null;

  const [currentJournal, latestJournalNotice] = await Promise.all([
    logicalDate
      ? composition.journalService.readByDate({ logicalDate, userId })
      : composition.journalService.readLatest({ userId }),
    composition.journalService.readLatestGenerationNotice({ userId }),
  ]);

  return (
    <div className="portalPage">
      <JournalView
        currentJournal={currentJournal}
        latestNotice={latestJournalNotice}
      />
    </div>
  );
}
