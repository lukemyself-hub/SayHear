import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { ContextInspector } from "../context-inspector";
import { createServerComposition } from "../../../src/server-composition";

export const dynamic = "force-dynamic";

type ContextInspectorPageProps = Readonly<{
  searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}>;

export default async function ContextInspectorPage(
  props: ContextInspectorPageProps,
) {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect(
      "/api/auth/signin?callbackUrl=/internal/context-inspector",
    );
  }

  const searchParams = await props.searchParams;
  const requestedId = searchParams.generation_command_id;
  const initialGenerationCommandId = Array.isArray(requestedId)
    ? requestedId[0] ?? ""
    : requestedId ?? "";

  return (
    <ContextInspector
      initialGenerationCommandId={initialGenerationCommandId}
    />
  );
}
