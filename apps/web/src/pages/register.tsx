// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Suspense } from "react";
import { AuthPage } from "./auth";

export default function RegisterPage() {
	return (
		<Suspense>
			<AuthPage initialMode="register" />
		</Suspense>
	);
}
