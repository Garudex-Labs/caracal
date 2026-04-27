import React, { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "@docusaurus/router";
import DocActions from "@site/src/components/DocActions";

type TOCItem = {
  id: string;
  label: string;
  level: number;
};

export default function DocItemTOCDesktop(): ReactNode {
  const { pathname } = useLocation();
  const [items, setItems] = useState<TOCItem[]>([]);

  useEffect(() => {
    if (typeof document === "undefined" || pathname === "/" || pathname.startsWith("/ai")) {
      setItems([]);
      return;
    }

    const root = document.querySelector(".theme-doc-markdown") ?? document.querySelector("main");
    if (!root) {
      setItems([]);
      return;
    }

    const headings = Array.from(root.querySelectorAll("h2[id], h3[id]")) as HTMLHeadingElement[];
    const nextItems = headings.map((heading) => ({
      id: heading.id,
      label: heading.textContent?.trim() ?? heading.id,
      level: heading.tagName === "H3" ? 3 : 2,
    }));

    setItems(nextItems);
  }, [pathname]);

  if (pathname === "/" || pathname.startsWith("/ai")) {
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
        {items.length > 0 ? (
          <ul className="table-of-contents table-of-contents__left-border">
            {items.map((item) => (
              <li key={item.id} className={`table-of-contents__item table-of-contents__item--level-${item.level}`}>
                <a className="table-of-contents__link" href={`#${item.id}`}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
