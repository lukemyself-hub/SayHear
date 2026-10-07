"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { ChatModuleList, type ChatNav } from "./chat-module-list";
import { JournalDateList } from "./journal-date-list";
import {
  createToolNavigationMemory,
  DEFAULT_TOOL_HREF,
  isLogicalDateValue,
  journalRailHref,
  resolveToolEntryHref,
  resolveToolsRailHref,
  toToolLocation,
} from "./portal-integration";

type WriteGate = Readonly<{ allowed: boolean; reason: string }>;

type PortalShellContextValue = Readonly<{
  clearDraft(key: string): void;
  draftFor(key: string): string;
  navOpen: boolean;
  setDraft(key: string, value: string): void;
  setNavOpen(open: boolean): void;
}>;

const PortalShellContext = createContext<PortalShellContextValue | null>(null);

/**
 * Reads the shell's draft/navigation context. Returns `null` when a component
 * is rendered outside the portal shell (for example an isolated unit render),
 * so consumers must still work without persistence.
 */
export function usePortalShell(): PortalShellContextValue | null {
  return useContext(PortalShellContext);
}

type ModuleKey = "chat" | "journal" | "tools";

const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function desktopSnapshot(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function desktopServerSnapshot(): boolean {
  return false;
}

function moduleForPathname(pathname: string): ModuleKey {
  if (pathname.startsWith("/internal/journals")) {
    return "journal";
  }
  if (
    pathname.startsWith("/internal/context-inspector") ||
    pathname.startsWith("/internal/reflection-inspector") ||
    pathname.startsWith("/internal/candidate-review")
  ) {
    return "tools";
  }
  return "chat";
}

function isToolActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PortalShell({
  chatNav,
  children,
}: {
  chatNav: ChatNav | null;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/internal";
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeDate = searchParams.get("date");
  const moduleKey = moduleForPathname(pathname);
  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    desktopSnapshot,
    desktopServerSnapshot,
  );
  const [navOverride, setNavOverride] = useState<boolean | null>(null);
  const navOpen = navOverride ?? isDesktop;
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [writeGate, setWriteGate] = useState<WriteGate | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // In-memory only (never localStorage/sessionStorage): the last tool entry the
  // reader opened, so the tools rail can restore a selected entry (AC-19). It
  // starts empty on every page load.
  const toolNavRef = useRef(createToolNavigationMemory());
  // The last Journal date the reader opened in this page session, so the
  // Journal rail returns to it instead of resetting to the latest Journal.
  const [lastJournalDate, setLastJournalDate] = useState<string | null>(null);

  useEffect(() => {
    if (!pathname.startsWith("/internal/journals")) {
      return;
    }
    const date = searchParams.get("date");
    if (isLogicalDateValue(date)) {
      setLastJournalDate((current) => (current === date ? current : date));
    }
  }, [pathname, searchParams]);

  useEffect(() => {
    let active = true;
    fetch("/api/internal/access", { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (!active) {
          return;
        }
        const privateWrites =
          typeof payload === "object" &&
          payload !== null &&
          "privateWrites" in payload
            ? (payload as { privateWrites?: unknown }).privateWrites
            : null;
        if (
          typeof privateWrites === "object" &&
          privateWrites !== null &&
          "allowed" in privateWrites &&
          "reason" in privateWrites
        ) {
          const gate = privateWrites as { allowed: unknown; reason: unknown };
          if (
            typeof gate.allowed === "boolean" &&
            typeof gate.reason === "string"
          ) {
            setWriteGate({ allowed: gate.allowed, reason: gate.reason });
          }
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!navOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setNavOverride(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navOpen]);

  const contextValue = useMemo<PortalShellContextValue>(
    () => ({
      clearDraft: (key) =>
        setDrafts((current) =>
          current[key] ? { ...current, [key]: "" } : current,
        ),
      draftFor: (key) => drafts[key] ?? "",
      navOpen,
      setDraft: (key, value) =>
        setDrafts((current) =>
          current[key] === value ? current : { ...current, [key]: value },
        ),
      setNavOpen: (open) => setNavOverride(open),
    }),
    [drafts, navOpen],
  );

  function closeNavigation(): void {
    // Only the narrow drawer closes on entry selection; on desktop the two
    // navigation columns stay where the user put them.
    if (!isDesktop) {
      setNavOverride(false);
    }
  }

  /**
   * Records the tool entry the reader is leaving, reading the live address so
   * the Context Inspector's `history.pushState` query survives even though the
   * router has not re-rendered. A no-op outside a tool route.
   */
  function rememberCurrentTool(): void {
    if (typeof window === "undefined") {
      return;
    }
    toolNavRef.current.remember(
      toToolLocation(window.location.pathname, window.location.search),
    );
  }

  function handleNavigate(): void {
    rememberCurrentTool();
    closeNavigation();
  }

  /**
   * The tools rail keeps the reader inside the tool they are viewing (with its
   * selected entry), or reopens the last tool entry from this page session.
   * Everything else falls through to the committed bare tool route.
   */
  function handleToolsRailClick(
    event: ReactMouseEvent<HTMLAnchorElement>,
  ): void {
    if (typeof window === "undefined") {
      return;
    }
    const target = resolveToolsRailHref({
      current: toToolLocation(
        window.location.pathname,
        window.location.search,
      ),
      lastActive: toolNavRef.current.lastActive(),
    });
    rememberCurrentTool();
    if (target !== DEFAULT_TOOL_HREF) {
      event.preventDefault();
      closeNavigation();
      router.push(target);
    }
  }

  function handleToolEntryClick(
    base: string,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ): void {
    if (typeof window === "undefined") {
      return;
    }
    const current = toToolLocation(
      window.location.pathname,
      window.location.search,
    );
    const target = resolveToolEntryHref({
      base,
      current,
      remembered: toolNavRef.current.rememberedFor(base),
    });
    rememberCurrentTool();
    closeNavigation();
    if (target !== base) {
      event.preventDefault();
      router.push(target);
    }
  }

  return (
    <PortalShellContext.Provider value={contextValue}>
      <div className="portalShell" data-nav-open={navOpen ? "true" : "false"}>
        <header className="portalHeader">
          <button
            aria-controls="portal-navigation"
            aria-expanded={navOpen}
            aria-label={navOpen ? "收起导航" : "展开导航"}
            className="portalHamburger"
            onClick={() => setNavOverride(!navOpen)}
            ref={triggerRef}
            type="button"
          >
            <span aria-hidden="true">{navOpen ? "×" : "☰"}</span>
          </button>
          <Link
            className="portalBrand"
            href="/internal"
            onClick={rememberCurrentTool}
          >
            SayHear
          </Link>
        </header>
        <div className="portalBody">
          {navOpen ? (
            <button
              aria-label="关闭导航"
              className="portalOverlay"
              onClick={() => {
                closeNavigation();
                triggerRef.current?.focus();
              }}
              type="button"
            />
          ) : null}
          <nav
            aria-label="模块导航"
            className="portalNav"
            id="portal-navigation"
          >
            <ModuleRail
              active={moduleKey}
              journalHref={journalRailHref(lastJournalDate)}
              onRememberTool={rememberCurrentTool}
              onToolsClick={handleToolsRailClick}
            />
            <ModuleList
              activeDate={activeDate}
              activeToolPath={pathname}
              chatNav={chatNav}
              module={moduleKey}
              onNavigate={handleNavigate}
              onToolEntryClick={handleToolEntryClick}
            />
            <div className="portalFooter">
              <span className="portalFooterOwner">Internal Owner</span>
              <span className="portalFooterState">
                {writeGate === null
                  ? "内部自用"
                  : writeGate.allowed
                    ? "内部自用 · 可写入"
                    : "内部自用 · 写入已阻断"}
              </span>
            </div>
          </nav>
          <div className="portalContent">{children}</div>
        </div>
      </div>
    </PortalShellContext.Provider>
  );
}

function ModuleRail({
  active,
  journalHref,
  onRememberTool,
  onToolsClick,
}: {
  active: ModuleKey;
  journalHref: string;
  onRememberTool: () => void;
  onToolsClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <div className="moduleRail">
      <Link
        aria-current={active === "chat" ? "page" : undefined}
        aria-label="聊天"
        className={`moduleRailLink${active === "chat" ? " isActive" : ""}`}
        href="/internal"
        onClick={onRememberTool}
        title="聊天"
      >
        <ChatIcon />
      </Link>
      <Link
        aria-current={active === "journal" ? "page" : undefined}
        aria-label="日记"
        className={`moduleRailLink${active === "journal" ? " isActive" : ""}`}
        href={journalHref}
        onClick={onRememberTool}
        title="日记"
      >
        <NotebookIcon />
      </Link>
      <Link
        aria-current={active === "tools" ? "page" : undefined}
        aria-label="检查工具"
        className={`moduleRailLink${active === "tools" ? " isActive" : ""}`}
        href={DEFAULT_TOOL_HREF}
        onClick={onToolsClick}
        title="检查工具"
      >
        <WrenchIcon />
      </Link>
    </div>
  );
}

const TOOLS: readonly Readonly<{ href: string; label: string }>[] = [
  { href: "/internal/context-inspector", label: "Context Inspector" },
  { href: "/internal/reflection-inspector", label: "Reflection Inspector" },
  { href: "/internal/candidate-review", label: "Candidate Review" },
];

function ModuleList({
  activeDate,
  activeToolPath,
  chatNav,
  module,
  onNavigate,
  onToolEntryClick,
}: {
  activeDate: string | null;
  activeToolPath: string;
  chatNav: ChatNav | null;
  module: ModuleKey;
  onNavigate: () => void;
  onToolEntryClick: (
    base: string,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => void;
}) {
  if (module === "tools") {
    return (
      <div className="moduleList">
        <p className="moduleListHeading">检查工具</p>
        <ul>
          {TOOLS.map((tool) => (
            <li key={tool.href}>
              <Link
                aria-current={
                  isToolActive(activeToolPath, tool.href) ? "page" : undefined
                }
                className="moduleListEntry"
                href={tool.href}
                onClick={(event) => onToolEntryClick(tool.href, event)}
              >
                {tool.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (module === "journal") {
    return (
      <Suspense
        fallback={
          <div className="moduleList">
            <p className="moduleListHeading">日记</p>
            <p className="moduleListNote">正在读取日记日期…</p>
          </div>
        }
      >
        <JournalDateList onNavigate={onNavigate} />
      </Suspense>
    );
  }
  return (
    <ChatModuleList
      activeDate={activeDate}
      initial={chatNav}
      onNavigate={onNavigate}
    />
  );
}

function ChatIcon() {
  return (
    <svg aria-hidden="true" focusable="false" height="20" viewBox="0 0 24 24" width="20">
      <path
        d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.4L4 19V6z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function NotebookIcon() {
  return (
    <svg aria-hidden="true" focusable="false" height="20" viewBox="0 0 24 24" width="20">
      <rect fill="none" height="17" rx="2" stroke="currentColor" strokeWidth="1.7" width="13" x="5.5" y="3.5" />
      <path d="M9.5 3.5v17M5.5 8h4M5.5 12h4M5.5 16h4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg aria-hidden="true" focusable="false" height="20" viewBox="0 0 24 24" width="20">
      <path
        d="M14.4 6.2a3.6 3.6 0 0 0-4.7 4.3l-5.9 5.9a1.9 1.9 0 1 0 2.7 2.7l5.9-5.9a3.6 3.6 0 0 0 4.3-4.7l-2.3 2.3-2.2-.6-.6-2.2 2.8-1.8z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}
