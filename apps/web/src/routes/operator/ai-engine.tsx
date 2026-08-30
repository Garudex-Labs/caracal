// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const OperatorAiEnginePage = lazy(() => import("@/pages/operator/ai-engine"));

export const Route = createFileRoute("/operator/ai-engine")({
	component: OperatorAiEnginePage,
});
