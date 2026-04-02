import React, { type ReactNode } from "react";
import clsx from "clsx";
import { ThemeClassNames } from "@docusaurus/theme-common";
import { translate } from "@docusaurus/Translate";
import DocSidebarItems from "@theme/DocSidebarItems";
import type { Props } from "@theme/DocSidebar/Desktop/Content";
import { getSidebarForPath } from "@site/src/theme/DocSidebar/shared";

export default function DocSidebarDesktopContent({ path, className }: Props): ReactNode {
  const sidebar = getSidebarForPath(path);

  if (sidebar.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label={translate({
        id: "theme.docs.sidebar.navAriaLabel",
        message: "Docs sidebar",
        description: "The ARIA label for the sidebar navigation",
      })}
      className={clsx("menu thin-scrollbar", ThemeClassNames.docs.docSidebarMenu, className)}
    >
      <ul className={clsx(ThemeClassNames.docs.docSidebarMenu, "menu__list")}>
        <DocSidebarItems items={sidebar} activePath={path} level={1} />
      </ul>
    </nav>
  );
}
