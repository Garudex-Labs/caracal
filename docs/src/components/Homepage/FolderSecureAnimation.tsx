/**
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the landing page folder-secure animation.
*/

import React, { useEffect, useRef, type ReactElement } from "react";
import useBaseUrl from "@docusaurus/useBaseUrl";
import lottie from "lottie-web";

export default function FolderSecureAnimation(): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationPath = useBaseUrl("/animations/folder-secure/animations/78cce903-fe54-493c-879c-40e0ce69f234.json");

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const animation = lottie.loadAnimation({
      container: containerRef.current,
      renderer: "svg",
      loop: false,
      autoplay: true,
      path: animationPath,
      rendererSettings: {
        progressiveLoad: true,
        preserveAspectRatio: "xMidYMid meet",
      },
    });

    return () => {
      animation.destroy();
    };
  }, [animationPath]);

  return <div aria-hidden="true" className="caracal-home__animation" ref={containerRef} />;
}