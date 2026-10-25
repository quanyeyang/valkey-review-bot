# Container image for the valkey-review agent.
#
# The image holds everything one review needs: a C toolchain and clangd
# for valkey, git and gh, a clone of valkey-io/valkey that each run
# fetches the pull request into, and the compiled agent.
#
# Stages:
#   base     Debian bookworm with Node.js.
#   build    Compiles the agent's TypeScript (agents/common and
#            agents/valkey-review) and drops dev dependencies.
#   runtime  base plus the toolchain, the clone, and the build output.
#
# Build with the repository root as the context: the agent imports
# agents/common.
#
# The base image is pinned by digest. Node.js (NODE_MAJOR from the
# NodeSource apt repository), gh and the Debian packages are whatever
# their apt repositories serve at build time.

ARG NODE_MAJOR=26

FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS base
ARG NODE_MAJOR
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version | grep -q "^v${NODE_MAJOR}\."

FROM base AS build

# Type-checking common's sources resolves their imports from
# agents/common/node_modules. At run time the compiled copy of common
# lives under the agent's dist/ and resolves from the agent's
# node_modules, which is why the agent declares common's dependencies.
WORKDIR /app/agents/common
COPY agents/common/package.json agents/common/package-lock.json ./
RUN npm ci

WORKDIR /app/agents/valkey-review
COPY agents/valkey-review/package.json agents/valkey-review/package-lock.json ./
RUN npm ci

COPY agents/common/src/ /app/agents/common/src/
COPY agents/valkey-review/tsconfig.json ./
COPY agents/valkey-review/src/ ./src/
# Dev dependencies are dropped by a production npm ci, not npm prune:
# prune resolves the tree again and stops on ERESOLVE, because
# @strands-agents/sdk declares an optional peer of openai 6 and the agent
# uses openai 7. npm ci installs the lockfile as it is.
RUN npx tsc -p tsconfig.json \
 && npm ci --omit=dev

FROM base AS runtime

# libssl-dev and libsystemd-dev back the BUILD_TLS and USE_SYSTEMD make
# vars. libgtest-dev and libgmock-dev are what `make test-unit` links.
# python3 runs valkey's code generators and the gtest runner.
RUN mkdir -p -m 0755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      git gh \
      build-essential pkg-config libc6-dev \
      libssl-dev libsystemd-dev libgtest-dev libgmock-dev \
      clangd clang \
      ripgrep jq \
      python3 \
 && rm -rf /var/lib/apt/lists/*

# The agent runs as an unprivileged user that owns the clone, so git
# needs no safe.directory exception. The agent's code goes in a
# root-owned directory: the agent user can read it but not change it.
RUN useradd --create-home --uid 1000 agent \
 && install -d -o agent -g agent /workspace \
 && install -d /app/agents/valkey-review
USER agent

# Each run fetches the pull request into this clone instead of cloning
# from scratch. blob:limit=1m keeps every tree and every blob up to 1 MB,
# so blame, log -S and log -- <path> run locally. A tree:0 filter would
# make blame fetch per commit and run past the git tool's time limit.
RUN git clone --filter=blob:limit=1m https://github.com/valkey-io/valkey.git /workspace/valkey

WORKDIR /app/agents/valkey-review
COPY --from=build /app/agents/valkey-review/package.json ./
COPY --from=build /app/agents/valkey-review/node_modules/ ./node_modules/
COPY --from=build /app/agents/valkey-review/dist/ ./dist/

ENV NODE_ENV=production \
    WORKSPACE_ROOT=/workspace/valkey

CMD ["node", "--enable-source-maps", "/app/agents/valkey-review/dist/valkey-review/src/agent.js"]
