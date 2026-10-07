import { getServerSession } from "next-auth";
import { notFound, redirect } from "next/navigation";

import {
  asUserId,
  RECENT_CONVERSATION_MESSAGE_LIMIT,
} from "@sayhear/application";

import { createServerComposition } from "../../src/server-composition";
import { HistoryConversation } from "./history-conversation";
import { TextConversation } from "./text-conversation";
import {
  conversationStatusLine,
  formatLogicalDate,
  isCurrentLocalDate,
} from "./portal-conversation";

export const dynamic = "force-dynamic";

type InternalPageProps = Readonly<{
  searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}>;

export default async function InternalPage(props: InternalPageProps) {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/internal");
  }

  const userId = asUserId(session.user.id);
  const searchParams = await props.searchParams;
  const rawDate = searchParams.date;
  const requestedDate = Array.isArray(rawDate) ? (rawDate[0] ?? "") : (rawDate ?? "");

  // The identity read is authoritative and never creates a Daily Session.
  const [access, identity] = await Promise.all([
    composition.accessService.getAccess(userId),
    composition.conversationService.readCurrentConversation(userId),
  ]);

  if (requestedDate.length > 0) {
    const conversation = await composition.conversationService.readConversationByDate(
      userId,
      requestedDate,
    );
    // A missing, malformed, or another owner's date fails explicitly.
    if (conversation === null) {
      notFound();
    }
    const [messages, interruptedResponses] = await Promise.all([
      composition.conversationService.listRecentMessages(userId, {
        dailySessionId: conversation.dailySessionId,
      }),
      composition.conversationService.listInterruptedResponsesForSession(
        userId,
        conversation.dailySessionId,
      ),
    ]);
    const now = composition.clock();
    const crossMidnight =
      identity !== null &&
      !isCurrentLocalDate({
        logicalDate: identity.logicalDate,
        now,
        timezone: identity.timezoneAtStart,
      });
    return (
      <HistoryConversation
        dailySessionId={conversation.dailySessionId}
        key={conversation.dailySessionId}
        initialHasOlder={
          messages.length >= RECENT_CONVERSATION_MESSAGE_LIMIT
        }
        initialInterruptedResponses={[...interruptedResponses]}
        initialMessages={[...messages]}
        returnHref="/internal"
        returnLabel={crossMidnight ? "返回交流" : "返回今天"}
        statusLine={`${formatLogicalDate(conversation.logicalDate)} · 历史记录`}
      />
    );
  }

  const [messages, interruptedResponses] = identity
    ? await Promise.all([
        composition.conversationService.listRecentMessages(userId, {
          dailySessionId: identity.dailySessionId,
        }),
        composition.conversationService.listInterruptedResponsesForSession(
          userId,
          identity.dailySessionId,
        ),
      ])
    : [[], []];

  return (
    <TextConversation
      draftKey={identity?.logicalDate ?? "no-active-session"}
      key={identity?.logicalDate ?? "no-active-session"}
      initialInterruptedResponses={[...interruptedResponses]}
      initialMessages={[...messages]}
      statusLine={
        identity
          ? conversationStatusLine({
              logicalDate: identity.logicalDate,
              now: composition.clock(),
              timezone: identity.timezoneAtStart,
            })
          : null
      }
      writeGate={access.privateWrites}
    />
  );
}
