/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides a lightweight, dependency-free token highlighter for inline code samples.
*/
import type { ReactNode } from "react";

export interface HighlightTheme {
  comment: string;
  string: string;
  number: string;
  keyword: string;
  call: string;
  type: string;
}

const CODE_KEYWORDS: Record<string, Set<string>> = {
  TypeScript: new Set([
    "import",
    "from",
    "const",
    "let",
    "var",
    "await",
    "async",
    "function",
    "return",
    "new",
    "if",
    "else",
    "for",
    "of",
    "in",
    "true",
    "false",
    "null",
    "undefined",
    "export",
    "default",
  ]),
  Python: new Set([
    "import",
    "from",
    "async",
    "def",
    "await",
    "with",
    "as",
    "return",
    "if",
    "else",
    "for",
    "in",
    "None",
    "True",
    "False",
    "class",
    "lambda",
    "and",
    "or",
    "not",
  ]),
  Go: new Set([
    "func",
    "return",
    "if",
    "else",
    "defer",
    "var",
    "nil",
    "package",
    "import",
    "range",
    "type",
    "struct",
    "go",
    "chan",
    "map",
    "const",
    "for",
  ]),
  Rego: new Set([
    "package",
    "import",
    "default",
    "if",
    "else",
    "not",
    "some",
    "every",
    "in",
    "with",
    "as",
    "contains",
    "true",
    "false",
    "null",
  ]),
  Shell: new Set([]),
};

const CODE_TOKENIZER =
  /(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+|[^A-Za-z_$\s]+)/g;

export function highlightCode(code: string, lang: string, theme: HighlightTheme): ReactNode[] {
  const keywords = CODE_KEYWORDS[lang] ?? new Set<string>();
  const out: ReactNode[] = [];
  const re = new RegExp(CODE_TOKENIZER);
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const [full, comment, str, num, ident] = match;
    if (comment) {
      out.push(
        <span key={key++} className={theme.comment}>
          {comment}
        </span>,
      );
    } else if (str) {
      out.push(
        <span key={key++} className={theme.string}>
          {str}
        </span>,
      );
    } else if (num) {
      out.push(
        <span key={key++} className={theme.number}>
          {num}
        </span>,
      );
    } else if (ident) {
      const isCall = /^\s*\(/.test(code.slice(re.lastIndex));
      let cls = "";
      if (keywords.has(ident)) cls = theme.keyword;
      else if (isCall) cls = theme.call;
      else if (/^[A-Z]/.test(ident)) cls = theme.type;
      if (cls) {
        out.push(
          <span key={key++} className={cls}>
            {ident}
          </span>,
        );
      } else {
        out.push(ident);
      }
    } else {
      out.push(full);
    }
  }
  return out;
}

// Theme-aware palette for code rendered over the adaptive page background.
export const ADAPTIVE_HIGHLIGHT: HighlightTheme = {
  comment: "italic text-muted-foreground/60",
  string: "text-emerald-600 dark:text-emerald-400",
  number: "text-amber-600 dark:text-amber-400",
  keyword: "text-accent-purple",
  call: "text-sky-600 dark:text-sky-400",
  type: "text-cyan-600 dark:text-cyan-400",
};

// Fixed palette tuned for the dark terminal surface (#0d1117), matching GitHub dark.
export const TERMINAL_HIGHLIGHT: HighlightTheme = {
  comment: "italic text-[#8b949e]",
  string: "text-[#a5d6ff]",
  number: "text-[#79c0ff]",
  keyword: "text-[#ff7b72]",
  call: "text-[#d2a8ff]",
  type: "text-[#ffa657]",
};
