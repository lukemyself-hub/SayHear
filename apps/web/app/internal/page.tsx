import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../src/server-composition";
import { TextConversation } from "./text-conversation";
import { JournalCard } from "./journal-card";

export const dynamic = "force-dynamic";

export default async function InternalPage() {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/internal");
  }

  const userId = asUserId(session.user.id);
  const [access, interruptedResponses, messages, currentJournal, latestJournalNotice] = await Promise.all([
    composition.accessService.getAccess(userId),
    composition.conversationService.listInterruptedResponses(userId),
    composition.conversationService.listMessages(userId),
    composition.journalService.readLatest({ userId }),
    composition.journalService.readLatestGenerationNotice({ userId }),
  ]);
  const state = access.privateWrites.allowed ? "Open" : "Blocked";

  return (
    <main className="shell">
      <section className="eyebrow">SayHear Internal Core</section>
      <h1>Private-write boundary</h1>
      <p className="lede">
        Signed in as the pre-provisioned Internal Owner. This surface exposes only
        the current write-gate state.
      </p>
      <section
        aria-live="polite"
        className={`gate ${access.privateWrites.allowed ? "gateOpen" : "gateBlocked"}`}
      >
        <span className="gateLabel">Real private writes</span>
        <strong>{state}</strong>
        <code>{access.privateWrites.reason}</code>
      </section>
      <p className="note">
        The gate opens only when the configured backup policy has current,
        verified retention evidence.
      </p>
      <nav className="internalNav" aria-label="Internal tools">
        <a href="/internal/context-inspector">Open Context Inspector →</a>
        <a href="/internal/reflection-inspector">Open Reflection Inspector →</a>
        <a href="/internal/candidate-review">Open Candidate Review →</a>
      </nav>
      <JournalCard currentJournal={currentJournal} latestNotice={latestJournalNotice} />
      <TextConversation
        initialInterruptedResponses={interruptedResponses}
        initialMessages={messages}
      />
    </main>
  );
}
