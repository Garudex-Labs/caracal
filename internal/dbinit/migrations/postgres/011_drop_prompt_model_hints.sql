-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Drop the unused prompt model_hints column. It was carried over from the
-- legacy model but is write-only: no read path (show/detail/wire) exposes it
-- and no harness adapter consumes it. Prompts materialize from their template
-- alone, so removing the column loses no functional information.

ALTER TABLE public.prompt_versions DROP COLUMN IF EXISTS model_hints;
