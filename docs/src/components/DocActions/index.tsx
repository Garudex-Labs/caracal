import React, { useEffect, useMemo, useState } from "react";

function copyText(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return Promise.resolve();
  }

  return navigator.clipboard.writeText(value);
}

function extractPageMarkdown(pageTitle: string): string {
  if (typeof document === "undefined") {
    return `# ${pageTitle}`;
  }

  const root = document.querySelector(".theme-doc-markdown");
  if (!root) {
    return `# ${pageTitle}`;
  }

  const blocks = Array.from(
    root.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > p, :scope > ul, :scope > ol, :scope > pre, :scope > blockquote"),
  );

  const lines = blocks
    .map((block) => {
      if (block.matches("h1")) {
        return `# ${block.textContent?.trim() ?? ""}`;
      }
      if (block.matches("h2")) {
        return `## ${block.textContent?.trim() ?? ""}`;
      }
      if (block.matches("h3")) {
        return `### ${block.textContent?.trim() ?? ""}`;
      }
      if (block.matches("p")) {
        return block.textContent?.trim() ?? "";
      }
      if (block.matches("ul, ol")) {
        return Array.from(block.querySelectorAll(":scope > li"))
          .map((item) => `- ${item.textContent?.trim() ?? ""}`)
          .join("\n");
      }
      if (block.matches("pre")) {
        return `\`\`\`\n${block.textContent?.trim() ?? ""}\n\`\`\``;
      }
      if (block.matches("blockquote")) {
        return (block.textContent?.trim() ?? "")
          .split("\n")
          .map((line) => `> ${line.trim()}`)
          .join("\n");
      }
      return "";
    })
    .filter(Boolean);

  return lines.join("\n\n").trim() || `# ${pageTitle}`;
}

export default function DocActions(): React.ReactElement {
  const [status, setStatus] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState("Caracal Docs");
  const [pageUrl, setPageUrl] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setPageUrl(window.location.href);
    setPageTitle(document.title.replace(/\s*\|\s*Caracal Docs$/, "").trim() || "Caracal Docs");
  }, []);

  const markdown = useMemo(() => {
    const content = extractPageMarkdown(pageTitle);
    return `${content}\n\nSource: ${pageUrl || "Current page"}\n`;
  }, [pageTitle, pageUrl]);
  const askPrompt = useMemo(
    () =>
      `Explain this Caracal documentation page:\nTitle: ${pageTitle}\nURL: ${
        pageUrl || "Current page"
      }\n\nPage content:\n\n${markdown.slice(0, 12000)}\n\nFocus on the most important workflow, caveats, and next steps.`,
    [markdown, pageTitle, pageUrl],
  );

  const handleCopyMarkdown = async () => {
    await copyText(markdown);
    setStatus("Copied.");
  };

  const handleAsk = async (url: string, name: string) => {
    await copyText(askPrompt);
    setStatus(`Prompt copied for ${name}.`);
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="caracal-doc-actions" role="toolbar" aria-label="Page actions">
      <button className="caracal-doc-actions__item" onClick={handleCopyMarkdown} type="button">
        <span className="caracal-doc-actions__icon" aria-hidden="true">
          ⎘
        </span>
        Copy as Markdown
      </button>
      <button
        className="caracal-doc-actions__item"
        onClick={() => handleAsk("https://chatgpt.com/", "ChatGPT")}
        type="button"
      >
        <span className="caracal-doc-actions__icon" aria-hidden="true">
          ↗
        </span>
        Ask ChatGPT
      </button>
      <button
        className="caracal-doc-actions__item"
        onClick={() => handleAsk("https://claude.ai/", "Claude")}
        type="button"
      >
        <span className="caracal-doc-actions__icon" aria-hidden="true">
          ↗
        </span>
        Ask Claude
      </button>
      {status ? (
        <div className="caracal-doc-actions__status" aria-live="polite">
          {status}
        </div>
      ) : null}
    </div>
  );
}
