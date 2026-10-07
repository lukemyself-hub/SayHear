import { PortalShell } from "./portal-shell";

/**
 * Shared responsive shell for every `/internal` route. It deliberately does no
 * authentication: each page keeps its own `getServerSession` guard and redirect,
 * and the shell only provides navigation, the draft/drawer context, and the
 * footer write-state read from the existing `/api/internal/access` contract.
 */
export default function InternalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <PortalShell>{children}</PortalShell>;
}
