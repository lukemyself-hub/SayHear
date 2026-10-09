import { getServerSession } from "next-auth";
import Link from "next/link";
import { redirect } from "next/navigation";

import { asUserId } from "@sayhear/application";

import { resolveOneA3bG1ReleaseManifest } from "../../../src/runtime-config";
import { createServerComposition } from "../../../src/server-composition";
import { lastAcceptedBusinessMigrationName } from "../release-operations-data";
import { ReleaseOperations } from "../release-operations";

export const dynamic = "force-dynamic";

/**
 * Internal Owner release-operations page (SPEC #292 compatibility deployment).
 *
 * It carries no new authorization: the page requires an authenticated session
 * and the existing Internal Owner capability, and every read/write it performs
 * goes through an already-existing session-authenticated endpoint. The page
 * only reads content-free metadata and calls the recent-context governance
 * endpoint on an explicit button click; it never auto-enables.
 *
 * The last accepted business migration name is parsed from the deployment's
 * own verified release manifest on the server. Only that one migration name is
 * passed to the client; the manifest, pins and environment never leave the
 * server.
 */
export default async function ReleaseOperationsPage() {
  const composition = createServerComposition();
  const session = await getServerSession(composition.authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/internal/release-operations");
  }

  try {
    await composition.accessService.assertOperator(asUserId(session.user.id));
  } catch {
    return (
      <div className="inspectorPage">
        <h1>暂时无法验证访问权限</h1>
        <p className="lede">
          该页面仅对 Internal Owner 开放。权限检查未通过或暂时不可用，未读取或写入任何发布数据。
        </p>
      </div>
    );
  }

  let lastBusinessMigration: string | null = null;
  try {
    lastBusinessMigration = lastAcceptedBusinessMigrationName(
      resolveOneA3bG1ReleaseManifest(process.env),
    );
  } catch {
    // An absent or invalid manifest stays honest: the page shows 未知 rather
    // than guessing a migration name.
    lastBusinessMigration = null;
  }

  return (
    <div className="inspectorPage">
      <Link className="reviewBackLink" href="/internal">
        ← 返回聊天
      </Link>
      <h1>Release Operations</h1>
      <p className="lede">
        Internal Owner 发布操作：这里只展示内容无关的部署身份、有效运行配置与最近上下文治理状态。
        启用/停用只在点击按钮后调用既有端点，不会自动开启；本页不读取也不展示任何用户内容。
      </p>
      <ReleaseOperations
        lastAcceptedBusinessMigration={lastBusinessMigration}
      />
    </div>
  );
}
