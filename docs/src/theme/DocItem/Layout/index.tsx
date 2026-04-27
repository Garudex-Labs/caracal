import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "@docusaurus/router";
import type { Props } from "@theme/DocItem/Layout";
import DocItemLayoutOriginal from "@theme-original/DocItem/Layout";

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function tableToLines(table: HTMLTableElement): string[] {
  const headers = Array.from(table.querySelectorAll("thead th")).map((cell) => normalizeText(cell.textContent || ""));
  const rows = Array.from(table.querySelectorAll("tbody tr"));

  if (headers.length === 0 || rows.length === 0) {
    return [];
  }

  return rows.map((row) => {
    const cells = Array.from(row.querySelectorAll("th, td")).map((cell) => normalizeText(cell.textContent || ""));
    const parts = cells
      .map((cell, index) => {
        const label = headers[index] || `field_${index + 1}`;
        return `${label}: ${cell}`;
      })
      .filter((part) => part.trim().length > 0);

    return `- ${parts.join("; ")}`;
  });
}

function listToLines(list: HTMLOListElement | HTMLUListElement): string[] {
  return Array.from(list.children).flatMap((item, index) => {
    if (!(item instanceof HTMLLIElement)) {
      return [];
    }

    const nestedLists = Array.from(item.querySelectorAll(":scope > ul, :scope > ol"));
    nestedLists.forEach((nestedList) => nestedList.remove());
    const text = normalizeText(item.textContent || "");
    const prefix = list instanceof HTMLOListElement ? `${index + 1}.` : "-";
    const lines = text ? [`${prefix} ${text}`] : [];

    nestedLists.forEach((nestedList) => item.appendChild(nestedList));

    return [...lines, ...nestedLists.flatMap((nestedList) => listToLines(nestedList as HTMLOListElement | HTMLUListElement))];
  });
}

function blockToLines(element: Element): string[] {
  const tagName = element.tagName.toLowerCase();

  if (tagName === "h1") {
    return [];
  }

  if (tagName === "h2" || tagName === "h3" || tagName === "h4") {
    const level = Number(tagName.slice(1));
    return [`${"#".repeat(level)} ${normalizeText(element.textContent || "")}`, ""];
  }

  if (tagName === "p") {
    const text = normalizeText(element.textContent || "");
    return text ? [text, ""] : [];
  }

  if (tagName === "blockquote") {
    const text = normalizeText(element.textContent || "");
    return text ? [`- ${text.replace(/^Canonical human page:\s*/i, "Canonical human page: ")}`, ""] : [];
  }

  if (tagName === "ul" || tagName === "ol") {
    return [...listToLines(element as HTMLOListElement | HTMLUListElement), ""];
  }

  if (tagName === "pre") {
    const code = (element.textContent || "").replace(/\s+$/, "");
    return code ? ["```", code, "```", ""] : [];
  }

  if (tagName === "table") {
    return [...tableToLines(element as HTMLTableElement), ""];
  }

  if (tagName === "hr") {
    return ["---", ""];
  }

  return Array.from(element.children).flatMap((child) => blockToLines(child));
}

function toAiText(markdown: HTMLElement, pathname: string): string {
  const title = normalizeText(markdown.querySelector("h1")?.textContent || "AI document");
  const bodyLines = Array.from(markdown.children).flatMap((child) => blockToLines(child));
  const body = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return [
    "---",
    'mode: "ai-text"',
    `route: "${pathname}"`,
    "---",
    `# ${title}`,
    "",
    body,
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n")
    .trim();
}

export default function DocItemLayout(props: Props): ReactNode {
  const { pathname } = useLocation();
  const isAiPath = pathname.startsWith("/ai");
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [plainText, setPlainText] = useState("");

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.body.classList.toggle("caracal-ai-mode", isAiPath);

    return () => {
      document.body.classList.remove("caracal-ai-mode");
    };
  }, [isAiPath]);

  useEffect(() => {
    if (!isAiPath || !layoutRef.current) {
      setPlainText("");
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const markdown = layoutRef.current?.querySelector(".theme-doc-markdown");
      const text = markdown instanceof HTMLElement ? toAiText(markdown, pathname) : "";
      setPlainText(text);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isAiPath, pathname]);

  return (
    <div className={isAiPath ? "caracal-docitem-layout-single-rail caracal-ai-doc-layout" : "caracal-docitem-layout-single-rail"} ref={layoutRef}>
      {isAiPath && plainText ? <pre className="caracal-ai-plaintext">{plainText}</pre> : null}
      <DocItemLayoutOriginal {...props} />
    </div>
  );
}
