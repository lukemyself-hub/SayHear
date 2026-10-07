import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { ReflectionInspector } from "../reflection-inspector";
import { createServerComposition } from "../../../src/server-composition";

export const dynamic = "force-dynamic";

type ReflectionInspectorPageProps = Readonly<{
  searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}>;

export default async function ReflectionInspectorPage(
  props: ReflectionInspectorPageProps,
) {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect(
      "/api/auth/signin?callbackUrl=/internal/reflection-inspector",
    );
  }
  const searchParams = await props.searchParams;
  const requestedId = searchParams.reflection_id;
  const initialReflectionId = Array.isArray(requestedId)
    ? requestedId[0] ?? ""
    : requestedId ?? "";
  return (
    // The client component reads the current `reflection_id` from the URL with
    // `useSearchParams`, which Next.js requires behind a Suspense boundary.
    <Suspense fallback={null}>
      <ReflectionInspector initialReflectionId={initialReflectionId} />
    </Suspense>
  );
}
