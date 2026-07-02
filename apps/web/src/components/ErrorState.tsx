/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the shared branded full-page error screen used across all error states.
*/
import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { useSession } from "@/platform/auth";
import { errorEntry } from "@/platform/errors/catalog";

const FUN_FACTS = [
  "Caracal mints a fresh, short-lived token for every request.",
  "Every AI operator action is authorized and recorded before it runs.",
  "The Control API only moves with a signed Caracal mandate.",
  "Grants expire on their own, so stale access never lingers.",
  "Delegated authority can never exceed what granted it.",
  "Any session can be revoked instantly across the gateway.",
  "Policies are evaluated fresh on every call, never cached.",
  "Zones keep every tenant fully isolated from the others.",
] as const;

function Sparkle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3v4M12 17v4M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

export function ErrorState({ code }: { code: number }) {
  const entry = errorEntry(code);
  const ringText = `Autonomous agent authority • Caracal • `;

  const session = useSession();
  const homeTo = session.data?.user ? "/app" : "/";
  const [factIndex] = useState(() => Math.floor(Math.random() * FUN_FACTS.length));

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-16">
      {/* React 19 hoists these into <head>; the Doto display face drives the pixel heading. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Doto:wght@100..900&display=swap"
      />

      <Link
        to="/"
        aria-label="Caracal home"
        className="absolute left-6 top-6 z-30 flex items-center transition-opacity hover:opacity-80"
      >
        <img
          src="/caracal_light.png"
          alt="Caracal"
          className="h-auto w-40 select-none object-contain dark:hidden sm:w-56 md:w-72"
        />
        <img
          src="/caracal_dark.png"
          alt="Caracal"
          className="hidden h-auto w-40 select-none object-contain dark:block sm:w-56 md:w-72"
        />
      </Link>

      <div className="relative z-10 flex flex-col items-center">
        <div className="relative mb-16">
          <svg
            aria-hidden
            viewBox="0 0 140 140"
            className="animate-spin-slow pointer-events-none absolute -left-8 -top-12 z-20 h-28 w-28 text-foreground sm:-left-16 sm:-top-20 sm:h-44 sm:w-44"
          >
            <defs>
              <path
                id="errorBadgePath"
                d="M 70,70 m -50,0 a 50,50 0 1,1 100,0 a 50,50 0 1,1 -100,0"
                fill="transparent"
              />
            </defs>
            <text
              className="fill-current text-[10px] uppercase"
              style={{ letterSpacing: "0.18em" }}
            >
              <textPath href="#errorBadgePath" startOffset="0%">
                {ringText}
              </textPath>
            </text>
          </svg>

          <div className="relative z-10">
            <div className="relative block overflow-hidden rotate-[4deg] bg-card shadow-2xl transition-transform duration-300 hover:rotate-0">
              <img
                src="/security.png"
                alt="Caracal security"
                className="h-56 w-80 select-none object-cover sm:h-72 sm:w-110"
              />
            </div>

            <svg
              aria-hidden
              viewBox="0 0 100 60"
              className="pointer-events-none absolute -right-16 top-1/2 hidden h-20 w-28 -translate-y-1/2 text-muted-foreground sm:block"
            >
              <path
                d="M 10 15 Q 20 10 30 15 Q 40 20 50 15 Q 60 10 70 15 Q 80 20 90 15"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                opacity="0.5"
              />
              <path
                d="M 10 25 Q 20 20 30 25 Q 40 30 50 25 Q 60 20 70 25 Q 80 30 90 25"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                opacity="0.5"
              />
              <path
                d="M 10 35 Q 20 30 30 35 Q 40 40 50 35 Q 60 30 70 35 Q 80 40 90 35"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                opacity="0.5"
              />
            </svg>
          </div>
        </div>

        <div className="max-w-3xl text-center">
          <p className="font-doto text-xl font-medium uppercase tracking-[0.35em] text-muted-foreground md:text-2xl">
            Error {code}
          </p>
          <h1 className="font-doto mt-3 text-balance text-4xl font-semibold leading-tight text-foreground sm:text-5xl md:text-6xl">
            {entry.title}
          </h1>

          <div className="mt-12 flex items-center justify-center gap-2 text-primary">
            <Sparkle className="h-4 w-4" />
            <span className="text-xs font-semibold uppercase tracking-[0.18em]">Did you know</span>
          </div>
          <p
            key={factIndex}
            className="animate-[caracalFadeIn_400ms_ease] mx-auto mt-2 max-w-full text-pretty text-base leading-relaxed text-muted-foreground md:whitespace-nowrap md:text-lg"
          >
            {FUN_FACTS[factIndex]}
          </p>

          <div className="mt-9 flex items-center justify-center gap-4 text-xs text-muted-foreground">
            <a
              href="https://docs.caracal.run"
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              Documentation
            </a>
            <span className="h-3 w-px bg-border" />
            <Link to={homeTo} className="hover:text-foreground">
              Home
            </Link>
            <span className="h-3 w-px bg-border" />
            <a
              href="https://github.com/Garudex-Labs/caracal/issues"
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              Report an issue
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
