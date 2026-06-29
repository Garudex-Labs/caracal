/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Request Trace route.
*/
import { appLink } from "@/platform/nav/appLink";
import { createFileRoute, Link } from "@tanstack/react-router";

import { ModuleNotice } from "@/components/console/ModuleNotice";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/trace")({
  component: TracePage,
});

function TracePage() {
  return (
    <ModuleNotice
      title="Request Trace"
      description="Follow a single request through every decision it triggered."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Request Trace" }]}
      noticeTitle="Tracing lives in Audit"
    >
      <p>
        Request tracing is now built into the audit experience. Open any event in{" "}
        <Link to={appLink("/audit")} className="font-medium text-foreground underline">
          Audit
        </Link>{" "}
        to see its full decision trace: the final decision, every event in the request, and any
        denied decisions, all in one place.
      </p>
    </ModuleNotice>
  );
}
