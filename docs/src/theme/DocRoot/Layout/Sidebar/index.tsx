import React, { type ReactNode, useCallback, useState } from "react";
import clsx from "clsx";
import { prefersReducedMotion, ThemeClassNames } from "@docusaurus/theme-common";
import { useLocation } from "@docusaurus/router";
import DocSidebar from "@theme/DocSidebar";
import ExpandButton from "@theme/DocRoot/Layout/Sidebar/ExpandButton";
import type { Props } from "@theme/DocRoot/Layout/Sidebar";
import styles from "./styles.module.css";

export default function DocRootLayoutSidebar({
  sidebar,
  hiddenSidebarContainer,
  setHiddenSidebarContainer,
}: Props): ReactNode {
  const { pathname } = useLocation();
  const [hiddenSidebar, setHiddenSidebar] = useState(false);

  const toggleSidebar = useCallback(() => {
    if (hiddenSidebar) {
      setHiddenSidebar(false);
    }

    if (!hiddenSidebar && prefersReducedMotion()) {
      setHiddenSidebar(true);
    }

    setHiddenSidebarContainer((value) => !value);
  }, [hiddenSidebar, setHiddenSidebarContainer]);

  if (pathname === "/") {
    return null;
  }

  return (
    <aside
      className={clsx(
        ThemeClassNames.docs.docSidebarContainer,
        styles.docSidebarContainer,
        hiddenSidebarContainer && styles.docSidebarContainerHidden,
      )}
      onTransitionEnd={(event) => {
        if (!event.currentTarget.classList.contains(styles.docSidebarContainer)) {
          return;
        }

        if (hiddenSidebarContainer) {
          setHiddenSidebar(true);
        }
      }}
    >
      <div className={clsx(styles.sidebarViewport, hiddenSidebar && styles.sidebarViewportHidden)}>
        <DocSidebar sidebar={sidebar} path={pathname} onCollapse={toggleSidebar} isHidden={hiddenSidebar} />
        {hiddenSidebar ? <ExpandButton toggleSidebar={toggleSidebar} /> : null}
      </div>
    </aside>
  );
}
