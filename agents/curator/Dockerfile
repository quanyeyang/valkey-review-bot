# Curator agent container: the concerns-store tools, skill graduation
# into AWS Agent Registry, and the skill maintenance runs. Unlike the
# reviewers it bakes no repository checkout and needs no language
# toolchains or language servers; a release check fetches the public
# upstream into a fresh directory under /tmp/skill-check and deletes it
# afterwards. The base image is pinned by digest.

FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build

ENV NODE_ENV=development

WORKDIR /app/agents/curator

# Type-checking common's sources resolves their imports from
# agents/common/node_modules. At run time the compiled copy of common
# lives under the curator's dist/ and resolves from the curator's
# node_modules, which is why the curator declares the dependencies of
# the common modules it imports. Both then load one copy of the SDK.
COPY agents/common/package.json agents/common/package-lock.json* /app/agents/common/
RUN cd /app/agents/common && npm ci --no-audit --no-fund

COPY agents/curator/package.json agents/curator/package-lock.json* /app/agents/curator/
RUN npm ci --no-audit --no-fund

COPY agents/common/src/ /app/agents/common/src/
COPY agents/curator/tsconfig.json /app/agents/curator/
COPY agents/curator/src/ /app/agents/curator/src/
RUN npx tsc --noEmit && npx tsc -p tsconfig.json

# Dev dependencies are dropped by a production npm ci, not npm prune:
# prune resolves the tree again and stops on ERESOLVE, because
# @strands-agents/sdk declares an optional peer of openai 6 and the curator
# uses openai 7. npm ci installs the lockfile as it is.
RUN npm ci --omit=dev --no-audit --no-fund

FROM public.ecr.aws/docker/library/node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS runtime

ENV NODE_ENV=production

WORKDIR /app/agents/curator

# git for the release check's upstream checkout, with the CA bundle for
# its https fetches. The checkouts go in a directory only the runtime
# user can write.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o node -g node -m 0700 /tmp/skill-check

COPY --from=build --chown=node:node /app/agents/curator/package.json /app/agents/curator/package.json
COPY --from=build --chown=node:node /app/agents/curator/node_modules /app/agents/curator/node_modules
COPY --from=build --chown=node:node /app/agents/curator/dist /app/agents/curator/dist

USER node

CMD ["node", "--enable-source-maps", "/app/agents/curator/dist/curator/src/agent.js"]
