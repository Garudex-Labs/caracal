/*
 * Copyright (C) 2026 Garudex Labs. All Rights Reserved.
 * Caracal, a product of Garudex Labs
 */

export type SearchDocEntry = {
  title: string;
  url: string;
  breadcrumbs: string[];
  description: string;
  searchText: string;
  parentTitle?: string;
  type: "page" | "heading" | "section";
};

export type NavigationAction = {
  title: string;
  description: string;
  to: string;
  keywords: string[];
  type: "navigation";
};
