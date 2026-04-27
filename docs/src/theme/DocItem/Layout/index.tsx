import React, { useEffect, type ReactNode } from "react";
import { useLocation } from "@docusaurus/router";
import type { Props } from "@theme/DocItem/Layout";
import DocItemLayoutOriginal from "@theme-original/DocItem/Layout";

export default function DocItemLayout(props: Props): ReactNode {
  const { pathname } = useLocation();
  const isAiPath = pathname.startsWith("/ai");

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.body.classList.toggle("caracal-ai-mode", isAiPath);

    return () => {
      document.body.classList.remove("caracal-ai-mode");
    };
  }, [isAiPath]);

  return (
    <div className={isAiPath ? "caracal-docitem-layout-single-rail caracal-ai-doc-layout" : "caracal-docitem-layout-single-rail"}>
      <DocItemLayoutOriginal {...props} />
    </div>
  );
}
