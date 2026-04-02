import React, { type ReactNode } from "react";
import { useLocation } from "@docusaurus/router";
import DocItemTOCDesktopOriginal from "@theme-original/DocItem/TOC/Desktop";
import DocActions from "@site/src/components/DocActions";

export default function DocItemTOCDesktop(): ReactNode {
  const { pathname } = useLocation();

  if (pathname === "/") {
    return null;
  }

  return (
    <div className="caracal-page-rail">
      <section className="caracal-page-rail__section">
        <div className="caracal-page-rail__title">AI tools</div>
        <DocActions />
      </section>
      <section className="caracal-page-rail__section">
        <div className="caracal-page-rail__title">On this page</div>
        <DocItemTOCDesktopOriginal />
      </section>
    </div>
  );
}
