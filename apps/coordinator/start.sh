#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Starts the Go relay in the background and Node coordinator in the foreground.
/relay &
exec node /app/dist/main.js
