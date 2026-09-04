import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { createServerComposition } from "../../../src/server-composition";

import { ProfileBioPrototype } from "./profile-bio-prototype";

export const dynamic = "force-dynamic";

export default async function ProfileBioPrototypePage() {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/prototype/profile-bio");
  }

  return (
    <Suspense>
      <ProfileBioPrototype />
    </Suspense>
  );
}
