import { getServerSession } from "next-auth";

import { asUserId } from "@sayhear/application";

import { createServerComposition } from "../../src/server-composition";
import type { ChatNav } from "./chat-module-list";
import { currentConversationEntryLabel } from "./portal-conversation";
import { PortalShell } from "./portal-shell";

export const dynamic = "force-dynamic";

/**
 * Shared responsive shell for every `/internal` route. Each page keeps its own
 * `getServerSession` guard and redirect; this layout only provides the
 * navigation data and the draft/drawer context. The navigation reads never
 * create a Daily Session and fail closed to an empty list, so a closed recovery
 * gate on a tool route cannot turn the shell into an error page.
 */
export default async function InternalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const chatNav = await readChatNav();
  return <PortalShell chatNav={chatNav}>{children}</PortalShell>;
}

async function readChatNav(): Promise<ChatNav | null> {
  try {
    const composition = createServerComposition();
    const session = await getServerSession(composition.authOptions);
    if (!session?.user?.id) {
      return null;
    }
    const userId = asUserId(session.user.id);
    const [identity, page] = await Promise.all([
      composition.conversationService.readCurrentConversation(userId),
      composition.conversationService.listConversationDates(userId, {
        cursor: null,
      }),
    ]);
    return {
      current: {
        label: identity
          ? currentConversationEntryLabel({
              logicalDate: identity.logicalDate,
              now: composition.clock(),
              timezone: identity.timezoneAtStart,
            })
          : "今天",
      },
      entries: page.entries.map((entry) => ({
        dailySessionId: entry.dailySessionId,
        logicalDate: entry.logicalDate,
      })),
      nextCursor: page.nextCursor,
    };
  } catch {
    return null;
  }
}
