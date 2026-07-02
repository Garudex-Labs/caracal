/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the shared application navigation shell.
*/
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";

type NavItem = {
  label: string;
  to?: string;
  caret?: boolean;
};

const NAV: NavItem[] = [
  { label: "README", to: "/" },
  { label: "ENTERPRISE", to: "/enterprise" },
  { label: "RESOURCES", caret: true },
  { label: "DOCS", to: "/docs" },
];

const RESOURCES = [
  { label: "Community", to: "/community" },
  { label: "Legal", to: "/legal" },
];

export function SiteShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link to="/" className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-sm bg-foreground text-background font-bold text-sm">
            H
          </div>
          <span className="font-mono text-sm font-semibold tracking-tight">Caracal</span>
        </Link>
        <button
          aria-label="Menu"
          onClick={() => setMobileOpen((s) => !s)}
          className="grid h-9 w-9 place-items-center rounded-md border border-border bg-card"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            {mobileOpen ? (
              <path d="M6 6l12 12M6 18L18 6" />
            ) : (
              <>
                <path d="M3 6h18" />
                <path d="M3 12h18" />
                <path d="M3 18h18" />
              </>
            )}
          </svg>
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden border-b border-border bg-card px-4 py-4 space-y-1">
          {NAV.filter((n) => n.to).map((n) => (
            <Link
              key={n.label}
              to={n.to!}
              onClick={() => setMobileOpen(false)}
              activeOptions={{ exact: n.to === "/" }}
              className="block rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-surface data-[status=active]:bg-surface"
            >
              {n.label}
            </Link>
          ))}
          <div className="pt-2 mt-2 border-t border-border">
            <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground">
              Resources
            </div>
            {RESOURCES.map((r) => (
              <Link
                key={r.label}
                to={r.to}
                onClick={() => setMobileOpen(false)}
                className="block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-surface hover:text-foreground"
              >
                {r.label}
              </Link>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Link
              to="/sign-in"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-foreground hover:bg-surface"
            >
              Log in
            </Link>
            <Link
              to="/sign-up"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md bg-foreground px-3 py-2 text-center text-sm font-medium text-background"
            >
              Sign up
            </Link>
          </div>
        </div>
      )}

      <div className="mx-auto grid w-full grid-cols-1 lg:grid-cols-[460px_1fr] xl:grid-cols-[520px_1fr]">
        <LeftRail />
        <main className="min-w-0 relative">
          <TopTabs />
          {children}
        </main>
      </div>
    </div>
  );
}

function LeftRail() {
  return (
    <aside className="hidden lg:flex relative flex-col justify-between overflow-hidden border-r border-border bg-surface px-8 py-8 lg:sticky lg:top-0 lg:h-screen">
      <GradientBars />
      <ThemeToggle />
      <Link to="/" className="relative z-10 -ml-2 flex items-center">
        <img
          src="/caracal_light.png"
          alt="Caracal"
          className="h-auto w-52 max-w-full select-none dark:hidden"
        />
        <img
          src="/caracal_dark.png"
          alt="Caracal"
          className="hidden h-auto w-52 max-w-full select-none dark:block"
        />
      </Link>

      <VisionPanel />

      <div className="relative z-10 flex-1" />

      <div className="relative z-10 space-y-6">
        <div className="flex justify-start">
          <LicenseBanner />
        </div>
        <h1 className="text-[1.9rem] font-medium leading-[1.05] tracking-tight text-foreground xl:text-[2.2rem]">
          Authority and Delegation layer for ai agents.
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/docs"
            className="inline-flex items-center justify-center rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background transition hover:bg-foreground/90"
          >
            Get Started
          </a>
          <a
            href="/pricing"
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium transition hover:bg-surface-2"
          >
            <span className="text-muted-foreground">+</span>Request a demo
          </a>
        </div>

        <div className="space-y-3 pt-6 text-xs text-muted-foreground">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <Link to="/community" className="hover:text-foreground">
              Community
            </Link>
            /
            <Link to="/legal" className="hover:text-foreground">
              Legal
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://x.com/caracalrun"
              aria-label="X / Twitter"
              className="hover:text-foreground"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2H21l-6.52 7.45L22.5 22h-6.79l-4.77-6.24L5.2 22H2.44l7-8L1.5 2h6.96l4.31 5.71L18.24 2Zm-1.19 18.4h1.5L7.07 3.5H5.46l11.59 16.9Z" />
              </svg>
            </a>
            <a
              href="https://github.com/Garudex-Labs/caracal"
              aria-label="GitHub"
              className="hover:text-foreground"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.96 3.22 9.16 7.69 10.65.56.1.77-.24.77-.54v-1.86c-3.13.68-3.79-1.51-3.79-1.51-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16.9-.25 1.86-.37 2.82-.38.96.01 1.92.13 2.82.38 2.15-1.46 3.09-1.16 3.09-1.16.62 1.55.23 2.7.11 2.98.72.79 1.16 1.8 1.16 3.03 0 4.33-2.64 5.28-5.15 5.56.4.35.76 1.04.76 2.1v3.11c0 .3.21.65.78.54 4.46-1.49 7.68-5.69 7.68-10.65C23.25 5.48 18.27.5 12 .5Z" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const isDark = stored ? stored === "dark" : true;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      className="absolute bottom-4 right-4 z-20 grid h-9 w-9 place-items-center text-muted-foreground transition hover:text-foreground"
    >
      {dark ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        </svg>
      )}
    </button>
  );
}

function LicenseBanner() {
  const [hovered, setHovered] = useState(false);

  const gearClasses = `pointer-events-none absolute text-accent-purple opacity-0 transition duration-300 ${
    hovered ? "rotate-180 opacity-100" : "rotate-0"
  }`;

  return (
    <div className="relative flex items-center justify-start">
      <div className="relative">
        <span
          aria-hidden="true"
          className={`${gearClasses} left-1 top-0.5 ${hovered ? "-translate-x-2 -translate-y-2" : ""}`}
        >
          <SettingsFilled />
        </span>
        <span
          aria-hidden="true"
          className={`${gearClasses} bottom-0.5 left-24 ${hovered ? "translate-x-2 translate-y-2" : ""}`}
        >
          <SettingsFilled />
        </span>
        <a
          href="/docs"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="relative flex h-8.75 items-center gap-1 rounded-md border border-border bg-card pl-2.5 pr-2 text-sm shadow-sm transition hover:border-accent-purple/50 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-sans text-[13px] font-medium text-foreground underline decoration-border underline-offset-[5px] transition hover:text-accent-purple hover:decoration-accent-purple/50">
            Open Source
          </span>
          <span className="text-[0.8125rem] text-muted-foreground">Apache 2.0 License</span>
          <span
            aria-hidden="true"
            className="grid h-5 w-5 place-items-center rounded-sm text-accent-purple transition hover:bg-accent"
          >
            ↗
          </span>
        </a>
      </div>
    </div>
  );
}

function SettingsFilled() {
  return (
    <svg
      data-testid="settings-icon"
      height="16"
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width="16"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.49999 0H6.49999L6.22628 1.45975C6.1916 1.64472 6.05544 1.79299 5.87755 1.85441C5.6298 1.93996 5.38883 2.04007 5.15568 2.15371C4.98644 2.2362 4.78522 2.22767 4.62984 2.12136L3.40379 1.28249L1.28247 3.40381L2.12135 4.62986C2.22766 4.78524 2.23619 4.98646 2.1537 5.15569C2.04005 5.38885 1.93995 5.62981 1.8544 5.87756C1.79297 6.05545 1.6447 6.19162 1.45973 6.2263L0 6.5V9.5L1.45973 9.7737C1.6447 9.80838 1.79297 9.94455 1.8544 10.1224C1.93995 10.3702 2.04006 10.6112 2.1537 10.8443C2.23619 11.0136 2.22767 11.2148 2.12136 11.3702L1.28249 12.5962L3.40381 14.7175L4.62985 13.8786C4.78523 13.7723 4.98645 13.7638 5.15569 13.8463C5.38884 13.9599 5.6298 14.06 5.87755 14.1456C6.05544 14.207 6.1916 14.3553 6.22628 14.5403L6.49999 16H9.49999L9.77369 14.5403C9.80837 14.3553 9.94454 14.207 10.1224 14.1456C10.3702 14.06 10.6111 13.9599 10.8443 13.8463C11.0135 13.7638 11.2147 13.7723 11.3701 13.8786L12.5962 14.7175L14.7175 12.5962L13.8786 11.3701C13.7723 11.2148 13.7638 11.0135 13.8463 10.8443C13.9599 10.6112 14.06 10.3702 14.1456 10.1224C14.207 9.94455 14.3553 9.80839 14.5402 9.7737L16 9.5V6.5L14.5402 6.2263C14.3553 6.19161 14.207 6.05545 14.1456 5.87756C14.06 5.62981 13.9599 5.38885 13.8463 5.1557C13.7638 4.98647 13.7723 4.78525 13.8786 4.62987L14.7175 3.40381L12.5962 1.28249L11.3701 2.12137C11.2148 2.22768 11.0135 2.2362 10.8443 2.15371C10.6111 2.04007 10.3702 1.93996 10.1224 1.85441C9.94454 1.79299 9.80837 1.64472 9.77369 1.45974L9.49999 0ZM8 11C9.65685 11 11 9.65685 11 8C11 6.34315 9.65685 5 8 5C6.34315 5 5 6.34315 5 8C5 9.65685 6.34315 11 8 11Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TopTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const isActive = (to?: string) => {
    if (!to) return false;
    if (to === "/") return pathname === "/";
    return pathname.startsWith(to);
  };

  return (
    <div className="sticky top-0 z-30 hidden lg:grid grid-cols-6 border-b border-border bg-background/85 backdrop-blur">
      {NAV.map((n) => {
        const active = isActive(n.to);
        const content = (
          <>
            {n.label}
            {n.caret && <span className="text-muted-foreground">▾</span>}
            {active && <span className="absolute inset-x-3 -bottom-px h-px bg-foreground" />}
          </>
        );
        const classes = `relative flex items-center justify-center gap-1 border-r border-border px-2 py-4 text-[11px] font-medium tracking-[0.14em] transition ${
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`;
        if (n.to && !n.caret) {
          return (
            <Link key={n.label} to={n.to} className={classes}>
              {content}
            </Link>
          );
        }
        const items = RESOURCES;
        return (
          <div
            key={n.label}
            className="relative"
            onMouseEnter={() => setOpenMenu(n.label)}
            onMouseLeave={() => setOpenMenu(null)}
          >
            <button className={classes + " w-full"}>{content}</button>
            {openMenu === n.label && (
              <div className="absolute left-0 right-0 top-full border border-t-0 border-border bg-card shadow-sm">
                {items.map((it) => (
                  <Link
                    key={it.label}
                    to={it.to}
                    className="block px-4 py-2.5 text-xs text-muted-foreground hover:bg-surface hover:text-foreground"
                  >
                    {it.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <Link
        to="/sign-in"
        className="flex items-center justify-center gap-1 border-r border-border px-2 py-4 text-[11px] font-medium tracking-[0.14em] text-muted-foreground transition hover:text-foreground"
      >
        SIGN IN
      </Link>
      <Link
        to="/sign-up"
        className="flex items-center justify-center gap-1 bg-foreground px-4 py-4 text-[11px] font-medium tracking-[0.14em] text-background hover:bg-foreground/90"
      >
        Sign up <span>↗</span>
      </Link>
    </div>
  );
}

function GradientBars({ numBars = 18 }: { numBars?: number }) {
  const barScale = (index: number, total: number) => {
    const position = index / (total - 1);
    const distanceFromCenter = Math.abs(position - 0.5);
    const heightPercentage = Math.pow(distanceFromCenter * 2, 1.2);
    return (30 + 70 * heightPercentage) / 100;
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden opacity-60"
    >
      <div className="flex h-full w-full">
        {Array.from({ length: numBars }).map((_, index) => {
          const scale = barScale(index, numBars);
          return (
            <div
              key={index}
              style={
                {
                  flex: `1 0 calc(100% / ${numBars})`,
                  maxWidth: `calc(100% / ${numBars})`,
                  height: "100%",
                  background: "linear-gradient(to top, var(--accent-purple), transparent)",
                  transform: `scaleY(${scale})`,
                  transformOrigin: "bottom",
                  transition: "transform 0.5s ease-in-out",
                  animation: "pulseBar 3s ease-in-out infinite alternate",
                  animationDelay: `${index * 0.1}s`,
                  "--initial-scale": scale,
                } as CSSProperties
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function VisionPanel() {
  return (
    <div className="relative z-10 mt-8 border border-border bg-background/20 px-7 py-9 backdrop-blur-md">
      <DotPattern width={12} height={12} cr={1} className="text-muted-foreground/30" />
      <span className="absolute -left-1 -top-1 h-2 w-2 bg-accent-purple" />
      <span className="absolute -right-1 -top-1 h-2 w-2 bg-accent-purple" />
      <span className="absolute -bottom-1 -left-1 h-2 w-2 bg-accent-purple" />
      <span className="absolute -bottom-1 -right-1 h-2 w-2 bg-accent-purple" />
      <div className="relative z-10">
        <span className="text-[11px] font-medium uppercase tracking-[0.25em] text-accent-purple">
          We believe
        </span>
        <p className="mt-4 text-[1.75rem] font-light leading-[1.08] tracking-tight text-muted-foreground">
          <span className="font-bold text-foreground">&ldquo;Authority</span> should be{" "}
          <span className="font-bold text-foreground">earned,</span> delegation{" "}
          <span className="font-bold text-foreground">scoped,</span> every{" "}
          <span className="font-bold text-foreground">agent</span> acts with{" "}
          <span className="font-bold text-foreground">proof.&rdquo;</span>
        </p>
      </div>
    </div>
  );
}

type DotPatternProps = {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  cr?: number;
  className?: string;
};

function DotPattern({
  width = 18,
  height = 18,
  x = 0,
  y = 0,
  cx = 1,
  cy = 1,
  cr = 1,
  className = "",
}: DotPatternProps) {
  const id = useId();

  return (
    <svg
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full fill-current ${className}`}
    >
      <defs>
        <pattern
          id={id}
          width={width}
          height={height}
          patternUnits="userSpaceOnUse"
          patternContentUnits="userSpaceOnUse"
          x={x}
          y={y}
        >
          <circle id="pattern-circle" cx={cx} cy={cy} r={cr} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" strokeWidth={0} fill={`url(#${id})`} />
    </svg>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
      <span className="h-px w-6 bg-border" />
      {children}
    </div>
  );
}
