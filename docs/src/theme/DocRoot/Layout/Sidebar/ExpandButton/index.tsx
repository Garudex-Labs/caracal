import React, { type ReactNode } from "react";
import { translate } from "@docusaurus/Translate";
import IconArrow from "@theme/Icon/Arrow";
import type { Props } from "@theme/DocRoot/Layout/Sidebar/ExpandButton";

export default function DocRootLayoutSidebarExpandButton({ toggleSidebar }: Props): ReactNode {
  return (
    <button
      type="button"
      className="caracal-sidebar-toggle caracal-sidebar-toggle--expand"
      title={translate({
        id: "theme.docs.sidebar.expandButtonTitle",
        message: "Expand sidebar",
        description: "The ARIA label and title attribute for expand button of doc sidebar",
      })}
      aria-label={translate({
        id: "theme.docs.sidebar.expandButtonAriaLabel",
        message: "Expand sidebar",
        description: "The ARIA label and title attribute for expand button of doc sidebar",
      })}
      onClick={toggleSidebar}
    >
      <IconArrow className="caracal-sidebar-toggle__icon" />
    </button>
  );
}
