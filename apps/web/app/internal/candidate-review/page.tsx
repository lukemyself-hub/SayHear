import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { createServerComposition } from "../../../src/server-composition";
import { CandidateReview } from "../candidate-review";

export const dynamic = "force-dynamic";

export default async function CandidateReviewPage() {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/internal/candidate-review");
  }

  return (
    <main className="shell">
      <section className="eyebrow">SayHear Internal Core</section>
      <h1>Candidate Review</h1>
      <p className="lede">
        Internal Owner 审查队列：来源与后继关系可见，处置经 B1 受限命令完成。
        Review 与 Reflection Inspector 是独立路由，只共用导航与认证。
      </p>
      <nav className="internalNav" aria-label="Internal tools">
        <a href="/internal">← Private-write boundary</a>
        <a href="/internal/context-inspector">Open Context Inspector →</a>
      </nav>
      <CandidateReview />
    </main>
  );
}
