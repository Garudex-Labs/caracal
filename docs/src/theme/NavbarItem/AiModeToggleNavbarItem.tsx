// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// This file provides the documentation mode switch navbar item.

import React, { useState, type ReactNode } from "react";
import { useLocation } from "@docusaurus/router";

export default function AiModeToggleNavbarItem(): ReactNode {
  const { pathname } = useLocation();
  const isAiPath = pathname.startsWith("/ai");
  const [isSwitching, setIsSwitching] = useState(false);
  const targetPath = isAiPath
    ? pathname === "/ai"
      ? "/"
      : pathname.replace(/^\/ai/, "") || "/"
    : pathname === "/"
      ? "/ai"
      : `/ai${pathname}`;

  const switchMode = () => {
    if (typeof window === "undefined" || isSwitching) {
      return;
    }

    setIsSwitching(true);
    window.setTimeout(() => {
      window.location.assign(targetPath);
    }, 620);
  };

  return (
    <>
      <button
        aria-checked={isAiPath}
        aria-label={isAiPath ? "Switch to human documentation" : "Switch to AI documentation"}
        className={isAiPath ? "caracal-mode-toggle caracal-mode-toggle--ai" : "caracal-mode-toggle"}
        onClick={switchMode}
        role="switch"
        type="button"
      >
        <span className="caracal-mode-toggle__label">AI MODE</span>
        <span className="caracal-mode-toggle__track">
          <span className="caracal-mode-toggle__thumb" />
        </span>
        <span className="caracal-mode-toggle__state">{isAiPath ? "ON" : "OFF"}</span>
      </button>
      {isSwitching ? (
        <div className={isAiPath ? "caracal-mode-transition caracal-mode-transition--off" : "caracal-mode-transition caracal-mode-transition--on"}>
          <div className="caracal-mode-transition__panel" />
          <div className="caracal-mode-transition__label">{isAiPath ? "RESTORING HUMAN DOCS" : "LOADING AI MODE"}</div>
        </div>
      ) : null}
    </>
  );
}
