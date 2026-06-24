/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file exposes a hook that opens a page's create form when arriving via a ?create deep link.
*/
import { useEffect, useRef } from "react";

import { useNavigate } from "@tanstack/react-router";

// Opens a page's create flow once when the route is reached with ?create=1 (or a matching
// token), then strips the param so a refresh or back navigation does not reopen it. Guided
// setup uses this to deep link operators straight into the real creation form they just
// learned about, turning "here is the button" into "here is the form, with its fields".
export function useCreateDeepLink(args: {
  to: string;
  value: string | undefined;
  open: () => void;
  match?: string;
}): void {
  const navigate = useNavigate();
  const fired = useRef(false);
  const { to, value, open, match } = args;
  useEffect(() => {
    const active = value === "1" || (match !== undefined && value === match);
    if (!active || fired.current) return;
    fired.current = true;
    open();
    navigate({ to, search: {}, replace: true });
  }, [to, value, open, match, navigate]);
}
