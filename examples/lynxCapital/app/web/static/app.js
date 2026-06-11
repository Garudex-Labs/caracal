/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Shared boot: marks active nav link based on current path.
 */

const path = location.pathname;
const map = {
  '/': 'nav-landing',
  '/setup': 'nav-setup',
  '/demo': 'nav-demo',
  '/prompts': 'nav-prompts',
  '/logs': 'nav-logs',
};
const id = path.startsWith('/overview/') ? 'nav-landing' : map[path];
if (id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}
