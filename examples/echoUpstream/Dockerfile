# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Minimal echo upstream image used as a self-contained protected target.

FROM node:22-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
EXPOSE 8088
CMD ["node", "server.mjs"]
