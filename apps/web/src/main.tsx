/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file is the client entry point that mounts the React SPA.
*/
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { getRouter } from "./router";
import "./styles/globals.css";

// An upgrade replaces hashed route chunks, so a tab from the previous build fails its
// next lazy navigation. Reloading fetches the current build; the timestamp guard keeps
// a genuinely broken network from looping the page.
window.addEventListener("vite:preloadError", (event) => {
  const last = Number(sessionStorage.getItem("chunkReloadAt") ?? 0);
  if (Date.now() - last < 10_000) return;
  sessionStorage.setItem("chunkReloadAt", String(Date.now()));
  event.preventDefault();
  window.location.reload();
});

const router = getRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
