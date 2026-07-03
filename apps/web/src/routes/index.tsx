/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the primary landing page.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SectionLabel } from "@/components/SiteShell";
import { ADAPTIVE_HIGHLIGHT, highlightCode } from "@/lib/codeHighlight";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Caracal" },
      {
        name: "description",
        content:
          "The identity and authorization layer for AI agents. Agents never hold credentials: every action is policy-approved before it runs, delegation can only narrow, and a tamper-evident audit trail proves what happened.",
      },
      { property: "og:title", content: "Caracal · Authority, not credentials, for AI agents" },
      {
        property: "og:description",
        content:
          "The identity and authorization layer for AI agents. Policy-approved actions, instant revocation, audit evidence.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <>
      <ReadmeSection />
      <FeaturesSection />
      <FrameworkSection />
      <PluginSection />
      <InfrastructureSection />
      <ContributorsSection />
      <FooterCTA />
    </>
  );
}

function ReadmeSection() {
  const tabs = ["Start", "Web", "Run"];
  const [active, setActive] = useState("Start");
  const [edition, setEdition] = useState<"oss" | "enterprise">("oss");
  const [menuOpen, setMenuOpen] = useState(false);
  const cmds: Record<string, string> = {
    Start: "caracal up",
    Web: "caracal web",
    Run: "caracal run -- node worker.js",
  };
  return (
    <section className="border-b border-border px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>README</SectionLabel>
      <p className="mt-6 max-w-3xl text-lg leading-snug tracking-tight text-foreground sm:text-xl md:text-[1.35rem]">
        <span className="font-medium">Caracal</span> gives AI agents authority, not credentials:
        short-lived, scoped, instantly revocable access to tools, APIs, and MCP servers. Every
        action is approved by policy before it runs.
      </p>

      <div className="mt-8 rounded-lg border border-border bg-card md:mt-10">
        <div className="flex items-center border-b border-border px-4 pt-3 sm:px-5">
          <div className="flex items-center gap-4 sm:gap-6">
            {edition === "oss" ? (
              tabs.map((t) => (
                <button
                  key={t}
                  onClick={() => setActive(t)}
                  className={`relative pb-3 text-xs font-medium tracking-wide whitespace-nowrap ${
                    active === t ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t}
                  {active === t && (
                    <span className="absolute inset-x-0 -bottom-px h-px bg-foreground" />
                  )}
                </button>
              ))
            ) : (
              <span className="pb-3 text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground/50">
                Enterprise
              </span>
            )}
          </div>
          <div className="relative ml-auto pb-3 pl-4">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-1 text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground hover:text-foreground"
            >
              {edition === "oss" ? "Open Source" : "Enterprise"}
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className={`transition ${menuOpen ? "rotate-180" : ""}`}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-20 mt-2 w-48 overflow-hidden rounded-md border border-border bg-card shadow-lg">
                <button
                  onClick={() => {
                    setEdition("oss");
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted"
                >
                  Open Source
                </button>
                <button
                  onClick={() => {
                    setEdition("enterprise");
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-muted-foreground/50 hover:bg-muted"
                >
                  Enterprise
                  <span className="text-[10px] tracking-wide uppercase">Coming soon</span>
                </button>
              </div>
            )}
          </div>
        </div>
        {edition === "oss" ? (
          <div className="flex items-center justify-between gap-3 px-4 py-4 font-mono text-xs sm:px-5 sm:text-sm">
            <span className="truncate">
              <span className="text-accent-purple">caracal</span>{" "}
              {cmds[active].replace(/^caracal /, "")}
            </span>
            <button
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="copy"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-4 font-mono text-xs text-muted-foreground/50 sm:px-5 sm:text-sm">
            <span className="text-accent-purple/40">caracal enterprise</span> deployment coming
            soon!!
          </div>
        )}
      </div>

      <TrustedBy />
    </section>
  );
}

function TrustedBy() {
  const supporters = [
    {
      name: "Microsoft for Startups",
      href: "https://www.microsoft.com/en-us/startups",
      logo: <MicrosoftLogo />,
    },
    {
      name: "Vercel OSS Program",
      href: "https://vercel.com/open-source-program",
      logo: <VercelLogo />,
    },
    {
      name: "Founders Inc. Canopy",
      href: "https://f.inc/canopy",
      logo: <FoundersIncLogo />,
    },
    {
      name: "LFX Mentorship (LFDT)",
      href: "https://mentorship.lfx.linuxfoundation.org/project/9cfe285b-7006-4610-84a8-1a52b0dff662",
      logo: <LfxLogo />,
    },
  ];
  return (
    <div className="relative mt-10">
      <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
        Supported By
      </div>
      <div className="overflow-hidden border-y border-border">
        <div className="marquee flex w-max gap-12 py-5">
          {[...supporters, ...supporters].map((s, i) => (
            <a
              key={i}
              href={s.href}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-muted-foreground/80 transition hover:text-foreground"
            >
              <span className="shrink-0">{s.logo}</span>
              {s.name}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
      <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

function VercelLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 2 22 20H2L12 2Z" />
    </svg>
  );
}

function FoundersIncLogo() {
  return (
    <img
      src="/finc.jpeg"
      alt="Founders Inc."
      width={18}
      height={18}
      className="h-4.5 w-4.5 object-cover"
    />
  );
}

function LfxLogo() {
  return (
    <img
      src="/lf.webp"
      alt="Linux Foundation"
      width={18}
      height={18}
      className="h-4.5 w-4.5 object-cover"
    />
  );
}

function FeaturesSection() {
  const feats = [
    {
      n: "01",
      title: "No long-lived agent secrets.",
      desc: "Scoped credentials are injected at runtime, never live in your code, and vanish the moment the agent stops.",
      chip: <SecretsChip />,
    },
    {
      n: "02",
      title: "Approve actions before they run.",
      desc: "Every agent request is checked against your policy up front, not flagged in a log after something already happened.",
      chip: <DecisionChip />,
    },
    {
      n: "03",
      title: "Authorization as code.",
      desc: "Define what agents may do in one declarative policy, and change it without redeploying a single agent.",
      chip: <PolicyChip />,
    },
    {
      n: "04",
      title: "Delegation that can only narrow.",
      desc: "Agents can hand work to other agents, but never with more access than they hold. Least privilege is enforced for you.",
      chip: <DelegationChip />,
    },
    {
      n: "05",
      title: "Revoke access instantly.",
      desc: "Shut down a runaway agent and everything it spawned loses access at once, no waiting for tokens to expire.",
      chip: <RevocationChip />,
    },
    {
      n: "06",
      title: "Audit you can hand to auditors.",
      desc: "Every who, what, and why is written to an append-only, tamper-evident trail you can export for compliance.",
      chip: <AuditChip />,
    },
    {
      n: "07",
      title: "Guard your APIs and MCP tools.",
      desc: "Put a verification gate in front of your services and MCP tools so only authorized agents ever reach them.",
      chip: <ConnectorChip />,
    },
    {
      n: "08",
      title: "Step up for risky actions.",
      desc: "Require fresh proof before an agent touches money or customer data. No standing exceptions, no blanket access.",
      chip: <StepUpChip />,
    },
    {
      n: "09",
      title: "Isolated by environment and tenant.",
      desc: "Run prod, staging, and per-customer workloads side by side with separate keys, rules, and audit.",
      chip: <ZoneChip />,
    },
  ];
  return (
    <section className="border-b border-border px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>Features</SectionLabel>
      <div className="mt-8 grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-3 [&>*]:bg-background">
        {feats.map((f) => (
          <div key={f.n} className="group flex flex-col p-6 transition hover:bg-surface">
            <div className="font-mono text-xs text-muted-foreground">{f.n}</div>
            <div className="mt-3 text-[15px] font-semibold tracking-tight">{f.title}</div>
            <p className="mt-1.5 text-sm text-muted-foreground">{f.desc}</p>
            <div className="mt-5 flex-1">{f.chip}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SecretsChip() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [seconds, setSeconds] = useState(30);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.4,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || refreshing) return;
    const id = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          setRefreshing(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [inView, refreshing]);

  useEffect(() => {
    if (!refreshing) return;
    const id = setTimeout(() => {
      setSeconds(30);
      setRefreshing(false);
    }, 1400);
    return () => clearTimeout(id);
  }, [refreshing]);

  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div ref={ref} className="space-y-1.5 font-mono text-[10px]">
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
        <span className="text-muted-foreground">OPENAI_API_KEY</span>
        <span
          className={`text-foreground transition-all duration-500 ${
            refreshing ? "scale-90 opacity-0 blur-[2px]" : "scale-100 opacity-100 blur-0"
          }`}
        >
          ••••
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
        <span className="text-muted-foreground">{refreshing ? "rotating" : "expires in"}</span>
        {refreshing ? (
          <span className="flex items-center gap-1 text-accent-purple">
            <span className="inline-block animate-spin">↻</span>
            fetching…
          </span>
        ) : (
          <span className="text-accent-purple">
            {mm}:{ss}
          </span>
        )}
      </div>
    </div>
  );
}
function DecisionChip() {
  const rows = [
    ["payments:read", "allow", "text-emerald-600"],
    ["tickets:write", "deny", "text-rose-600"],
    ["customer:export", "step-up", "text-amber-600"],
  ];
  return (
    <div className="space-y-1.5 font-mono text-[10px]">
      {rows.map(([req, decision, color]) => (
        <div
          key={req}
          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5"
        >
          <span className="text-muted-foreground">{req}</span>
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground/70">policy →</span>
            <span className={color}>{decision}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
function PolicyChip() {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 font-mono text-[11px] leading-5">
      <div>
        <span className="text-accent-purple">allow</span> if {"{"}
      </div>
      <div className="pl-3 text-muted-foreground">scope ⊆ grant</div>
      <div className="pl-3 text-muted-foreground">agent.label == "trusted"</div>
      <div>{"}"}</div>
    </div>
  );
}
function DelegationChip() {
  return (
    <div className="flex items-center gap-2 font-mono text-[10px]">
      <span className="rounded-md border border-border bg-card px-2 py-1">
        parent <span className="text-muted-foreground">[read, write]</span>
      </span>
      <span className="text-muted-foreground">→</span>
      <span className="rounded-md border border-border bg-card px-2 py-1">
        child <span className="text-accent-purple">[read]</span>
      </span>
    </div>
  );
}
function RevocationChip() {
  return (
    <div className="space-y-1 font-mono text-[10px]">
      <div className="flex items-center gap-2">
        <span className="rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-rose-700">
          revoked
        </span>
        <span className="text-foreground">agent-7f3a</span>
      </div>
      <div className="pl-4 text-muted-foreground">↳ 3 child agents cut off</div>
    </div>
  );
}
function AuditChip() {
  const rows = [
    ["10:50", "agent-7f3a", "allow", "payments:read", "bg-emerald-500 text-white"],
    ["10:48", "agent-2c1b", "deny", "tickets:write", "bg-rose-500 text-white"],
    ["10:45", "agent-9d4e", "step-up", "customer:read", "bg-amber-500 text-white"],
  ];
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card font-mono text-[10px]">
      {rows.map(([time, agent, decision, scope, tone], i) => (
        <div
          key={agent}
          className={`flex items-center gap-2 px-2.5 py-1.5 ${i > 0 ? "border-t border-border" : ""}`}
        >
          <span className="text-muted-foreground/70">{time}</span>
          <span className="text-foreground">{agent}</span>
          <span className={`ml-auto px-1.5 py-0.5 ${tone}`}>{decision}</span>
          <span className="text-muted-foreground">{scope}</span>
        </div>
      ))}
    </div>
  );
}
function ConnectorChip() {
  const items = ["MCP", "REST", "FastAPI", "Express", "+6"];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span
          key={i}
          className="grid h-7 place-items-center rounded-md border border-border bg-card px-2 text-[10px] font-medium"
        >
          {i}
        </span>
      ))}
    </div>
  );
}
function StepUpChip() {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px]">
      <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-700">
        challenge
      </span>
      <span className="text-muted-foreground">→</span>
      <span className="rounded-md border border-border bg-card px-2 py-1">proof</span>
      <span className="text-muted-foreground">→</span>
      <span className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-700">
        granted
      </span>
    </div>
  );
}
function ZoneChip() {
  const zones = ["prod", "staging", "customer:123"];
  return (
    <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
      {zones.map((z) => (
        <span key={z} className="rounded-full border border-border bg-card px-2 py-0.5">
          {z}
        </span>
      ))}
    </div>
  );
}

function FrameworkSection() {
  const langs = {
    TypeScript: { file: "ts agent.ts", install: "npm install @caracalai/sdk" },
    Python: { file: "py agent.py", install: "pip install caracalai-sdk" },
    Go: { file: "go agent.go", install: "go get github.com/garudex-labs/caracal/packages/sdk/go" },
  };
  const steps = [
    {
      label: "CONNECT THE SDK",
      desc: "new Caracal() loads your generated profile or environment config and prepares short-lived app-secret token exchange.",
      code: {
        TypeScript: `import { Caracal } from "@caracalai/sdk"

// Loads the generated profile or env config and
// prepares short-lived app-secret token exchange.
const caracal = new Caracal()`,
        Python: `from caracalai import Caracal

# Loads the generated profile or env config and
# prepares short-lived app-secret token exchange.
caracal = Caracal()`,
        Go: `// Loads the generated profile or env config and
// prepares short-lived app-secret token exchange.
c, err := caracal.New()
if err != nil {
    panic(err)
}`,
      },
    },
    {
      label: "SPAWN A SESSION",
      desc: "spawn() opens an agent session, binds its authority context, and tears it down the moment the block returns.",
      code: {
        TypeScript: `// spawn() opens an agent session, binds its
// authority context, and tears it down on exit.
await caracal.spawn(async () => {
  // every gateway call runs inside this session
})`,
        Python: `import asyncio

# spawn() opens an agent session, binds its
# authority context, and tears it down on exit.
async def main():
    async with caracal.spawn():
        ...  # gateway calls run inside this session

asyncio.run(main())`,
        Go: `// Spawn() opens an agent session, binds its
// authority context, and tears it down on exit.
err = c.Spawn(context.Background(), func(ctx context.Context) error {
    // every gateway call runs inside this session
    return nil
})`,
      },
    },
    {
      label: "ROUTE THROUGH THE GATEWAY",
      desc: "gatewayRequest() builds the Gateway URL and X-Caracal-Resource header so every call reaches the right resource.",
      code: {
        TypeScript: `const resourceId = process.env.CARACAL_RESOURCE_ID!
const resourcePath = process.env.CARACAL_RESOURCE_PATH!

// Builds the Gateway URL and X-Caracal-Resource header.
const request = caracal.gatewayRequest(resourceId, resourcePath)`,
        Python: `import os

resource_id = os.environ["CARACAL_RESOURCE_ID"]
resource_path = os.environ["CARACAL_RESOURCE_PATH"]

# Builds the Gateway URL and X-Caracal-Resource header.
request = caracal.gateway_request(resource_id, resource_path)`,
        Go: `resourceID := os.Getenv("CARACAL_RESOURCE_ID")
resourcePath := os.Getenv("CARACAL_RESOURCE_PATH")

// Builds the Gateway URL and X-Caracal-Resource header.
target, err := c.GatewayRequest(resourceID, resourcePath)
if err != nil {
    return err
}`,
      },
    },
    {
      label: "INJECT SECURE TRANSPORT",
      desc: "transport() attaches Authorization, trace, and baggage headers and enforces Gateway routing on each request.",
      code: {
        TypeScript: `// transport() attaches Authorization, trace, and
// baggage headers and enforces Gateway routing.
const response = await caracal.transport()(request.url, {
  method: "POST",
  headers: { ...request.headers, "Content-Type": "application/json" },
  body: JSON.stringify({ amount: 1200 }),
})

console.log(await response.text())`,
        Python: `# transport() attaches Authorization, trace, and
# baggage headers and enforces Gateway routing.
async with caracal.transport() as client:
    response = await client.post(
        request.url,
        headers=request.headers,
        json={"amount": 1200},
    )
    print(response.text)`,
        Go: `// Transport() injects Authorization, trace, and baggage.
req, err := http.NewRequestWithContext(
    ctx, http.MethodPost, target.URL,
    strings.NewReader(\`{"amount":1200}\`),
)
if err != nil {
    return err
}
req.Header = target.Header.Clone()
req.Header.Set("Content-Type", "application/json")

resp, err := c.Transport(nil).Do(req)
if err != nil {
    return err
}
defer resp.Body.Close()`,
      },
    },
  ];
  const names = Object.keys(langs) as Array<keyof typeof langs>;
  const [lang, setLang] = useState<keyof typeof langs>("TypeScript");
  const [langOpen, setLangOpen] = useState(false);
  const [active, setActive] = useState(0);
  const current = langs[lang];
  return (
    <section className="border-b border-border px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>Trust Layer</SectionLabel>
      <h3 className="mt-6 max-w-2xl text-2xl font-medium tracking-tight md:text-3xl">
        One SDK to give agents short-lived, gateway-routed authority in TypeScript, Python, or Go.
      </h3>

      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs">
            <span className="h-2 w-2 rounded-full bg-rose-400" />
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="ml-3 font-mono text-muted-foreground">{current.file}</span>
            <div className="relative ml-auto">
              <button
                onClick={() => setLangOpen((o) => !o)}
                className="flex items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground"
              >
                <LangLogo name={lang} />
                {lang}
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className={`transition ${langOpen ? "rotate-180" : ""}`}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {langOpen && (
                <div className="absolute right-0 top-full z-20 mt-2 w-36 overflow-hidden rounded-md border border-border bg-card shadow-lg">
                  {names.map((n) => (
                    <button
                      key={n}
                      onClick={() => {
                        setLang(n);
                        setLangOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left font-medium hover:bg-muted ${
                        n === lang ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      <LangLogo name={n} />
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="border-b border-border px-4 py-2 font-mono text-[11px] text-accent-purple">
            $ {current.install}
          </div>
          <pre className="h-80 overflow-auto p-5 font-mono text-[12.5px] leading-6 text-foreground/90">
            {highlightCode(steps[active].code[lang], lang, ADAPTIVE_HIGHLIGHT)}
          </pre>
        </div>

        <div className="flex flex-col">
          {steps.map((s, i) => (
            <button
              key={s.label}
              onClick={() => setActive(i)}
              className={`border-b border-border py-4 text-left transition ${
                active === i ? "" : "opacity-60 hover:opacity-100"
              }`}
            >
              <div className="text-[11px] font-semibold tracking-[0.18em] text-foreground">
                {s.label}
              </div>
              {active === i && <p className="mt-2 text-sm text-muted-foreground">{s.desc}</p>}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function LangLogo({ name }: { name: string }) {
  if (name === "Python") {
    return (
      <svg width="14" height="14" viewBox="0 0 256 255" aria-hidden="true">
        <defs>
          <linearGradient id="pyA" x1="12.96%" y1="12.04%" x2="79.64%" y2="78.2%">
            <stop offset="0" stopColor="#387EB8" />
            <stop offset="1" stopColor="#366994" />
          </linearGradient>
          <linearGradient id="pyB" x1="19.13%" y1="20.58%" x2="90.74%" y2="88.43%">
            <stop offset="0" stopColor="#FFE052" />
            <stop offset="1" stopColor="#FFC331" />
          </linearGradient>
        </defs>
        <path
          fill="url(#pyA)"
          d="M126.916.072c-64.832 0-60.784 28.115-60.784 28.115l.072 29.128h61.868v8.745H41.631S.145 61.355.145 126.77c0 65.417 36.21 63.097 36.21 63.097h21.61v-30.356s-1.165-36.21 35.632-36.21h61.362s34.475.557 34.475-33.319V33.97S224.667.072 126.916.072zM92.802 19.66a11.12 11.12 0 0 1 11.13 11.13 11.12 11.12 0 0 1-11.13 11.13 11.12 11.12 0 0 1-11.13-11.13 11.12 11.12 0 0 1 11.13-11.13z"
        />
        <path
          fill="url(#pyB)"
          d="M128.757 254.126c64.832 0 60.784-28.115 60.784-28.115l-.072-29.127H127.6v-8.745h86.441s41.486 4.705 41.486-60.712c0-65.416-36.21-63.096-36.21-63.096h-21.61v30.355s1.165 36.21-35.632 36.21h-61.362s-34.475-.557-34.475 33.32v56.013s-5.235 33.897 92.518 33.897zm34.114-19.586a11.12 11.12 0 0 1-11.13-11.13 11.12 11.12 0 0 1 11.13-11.131 11.12 11.12 0 0 1 11.13 11.13 11.12 11.12 0 0 1-11.13 11.13z"
        />
      </svg>
    );
  }
  if (name === "Go") {
    return (
      <span className="grid h-4 place-items-center rounded-[3px] bg-[#00ADD8] px-1 text-[7px] font-bold text-white">
        Go
      </span>
    );
  }
  return (
    <span className="grid h-4 w-4 place-items-center rounded-[3px] bg-[#3178C6] text-[8px] font-bold text-white">
      TS
    </span>
  );
}

function PluginSection() {
  const columns = [
    {
      title: "Languages",
      items: ["TypeScript", "Python", "Go", "Any CLI via caracal run"],
      more: "More native SDKs on the way",
    },
    {
      title: "AI Frameworks",
      items: ["LangChain", "LangGraph", "CrewAI", "OpenAI Agents SDK", "Custom agents"],
      more: "Any framework (Caracal is framework-agnostic)",
    },
    {
      title: "Provider Types",
      items: [
        "API key",
        "OAuth 2.0 user (authorization code)",
        "OAuth 2.0 machine (client credentials)",
        "Bearer token",
        "Caracal mandate",
      ],
      more: "None · MCP · Provider SDK",
    },
  ];
  return (
    <section className="border-b border-border px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <div className="flex items-baseline justify-between">
        <SectionLabel>Works With</SectionLabel>
      </div>
      <div className="mt-8 grid grid-cols-1 gap-px bg-border md:grid-cols-3 [&>*]:bg-background">
        {columns.map((col) => (
          <div key={col.title} className="flex flex-col p-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {col.title}
            </div>
            <ul className="mt-4 space-y-2.5">
              {col.items.map((it) => (
                <li key={it} className="flex items-center gap-2.5 text-sm font-medium">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-purple" />
                  {it}
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
              + {col.more}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function InfrastructureSection() {
  const services = [
    {
      title: "STS",
      port: ":8080",
      desc: "Issues short-lived, signed mandates.",
      items: ["Token exchange", "Mandate issuance + JWKS", "Policy evaluation", "Step-up status"],
    },
    {
      title: "Gateway",
      port: ":8081",
      desc: "Protected reverse proxy for upstreams.",
      items: ["Per-request exchange", "Revocation checks", "Strips caller auth", "Upstream safety"],
    },
    {
      title: "Coordinator",
      port: ":4000",
      desc: "Tracks the live authority graph.",
      items: ["Agent sessions", "Service leases", "Delegation edges", "Invocations"],
    },
    {
      title: "Audit",
      port: ":9090",
      desc: "Tamper-evident evidence pipeline.",
      items: ["Ingestion + DLQ", "Tamper checks", "Retention", "Search"],
    },
    {
      title: "Admin API",
      port: ":3000",
      desc: "Manages product and policy state.",
      items: ["Zones, resources, providers", "Policies & grants", "Admin audit", "API outbox"],
    },
    {
      title: "Control",
      port: ":8087",
      desc: "Automatable remote management.",
      items: ["Engine dispatch", "Replay-protected", "Rate-limited", "Fully audited"],
    },
  ];
  const stores = ["Postgres", "Redis", "caracal run", "Console CLI"];
  return (
    <section className="border-b border-border px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>Infrastructure</SectionLabel>
      <p className="mt-6 max-w-3xl text-base leading-snug text-muted-foreground md:text-[1.1rem]">
        Caracal ships as small, explicit services you run yourself. Each owns one bounded part of
        the authority lifecycle and exposes health and readiness endpoints for operations.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-px bg-border md:grid-cols-2 lg:grid-cols-3 [&>*]:bg-background">
        {services.map((s) => (
          <div key={s.title} className="p-6">
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="text-base font-semibold tracking-tight">{s.title}</h4>
              <span className="font-mono text-xs text-accent-purple">{s.port}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{s.desc}</p>
            <ul className="mt-4 space-y-1.5">
              {s.items.map((it) => (
                <li key={it} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="text-foreground">+</span>
                  {it}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function ContributorsSection() {
  const handles = [
    "RAWx18",
    "yashgo0018",
    "pratyush07-hub",
    "Mohammad-Ali-Haider",
    "Slo-Pix",
    "umar-aziz-dev",
    "aayushprsingh",
    "Ashutoshx7",
  ];
  return (
    <section className="border-b border-border px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>Contributors</SectionLabel>
      <p className="mt-6 max-w-2xl text-base text-muted-foreground md:text-[1.1rem]">
        Built by a community of <span className="text-foreground font-medium">20+</span>{" "}
        contributors.
      </p>
      <div className="mt-8 flex flex-wrap gap-1.5">
        {handles.map((handle) => (
          <a
            key={handle}
            href={`https://github.com/${handle}`}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={handle}
          >
            <img
              src={`https://github.com/${handle}.png?size=64`}
              alt={handle}
              loading="lazy"
              className="h-9 w-9 rounded-full border border-border bg-surface object-cover grayscale transition hover:grayscale-0"
            />
          </a>
        ))}
      </div>
    </section>
  );
}

function FooterCTA() {
  return (
    <section className="px-4 py-16 text-center sm:px-6 md:px-10 md:py-20">
      <h2 className="mx-auto max-w-2xl text-3xl font-medium tracking-tight md:text-4xl">
        Authority Before Autonomy
      </h2>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <a
          href="https://cal.com/rawx18/caracal-enterprise-sales"
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-md bg-foreground px-5 py-3 text-sm font-medium text-background hover:bg-foreground/90"
        >
          Request a demo
        </a>
        <a
          href="https://docs.caracal.run"
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-md border border-border bg-card px-5 py-3 text-sm font-medium hover:bg-surface"
        >
          Read the docs
        </a>
      </div>
      <div className="mt-16 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        © Garudex Labs 2026 | Caracal, a product of Garudex Labs
      </div>
    </section>
  );
}
