import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../src/server-composition";
import { TextConversation } from "./text-conversation";
import { conversationStatusLine } from "./portal-conversation";

export const dynamic = "force-dynamic";

export default async function InternalPage() {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/internal");
  }

  const userId = asUserId(session.user.id);
  // The identity read is authoritative and never creates a Daily Session.
  const [access, identity] = await Promise.all([
    composition.accessService.getAccess(userId),
    composition.conversationService.readCurrentConversation(userId),
  ]);
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
