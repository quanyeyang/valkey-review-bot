# Container image for the valkey-glide-review agent.
#
# valkey-glide is a Rust core with Java, Python, Node.js and Go bindings.
# The image carries the toolchains the agent's build tool runs (cargo,
# Gradle, go, npm), git and gh, a clone of valkey-io/valkey-glide that
# each run fetches the pull request into, and the compiled agent.
#
# Stages:
#   base     Debian bookworm with Node.js.
#   build    Compiles the agent's TypeScript (agents/common and
#            agents/valkey-glide-review) and drops dev dependencies.
#   runtime  base plus the toolchains, the clone, and the build output.
#
# Build with the repository root as the context: the agent imports
# agents/common.
#
# Pinned: the base image by digest, and the JDK, protoc, Go, zig and
# cargo-zigbuild downloads by version, each checked against the SHA-256
# published with its release. Not pinned: Node.js comes from the
# NodeSource apt repository for NODE_MAJOR, Rust from rustup's stable
# channel, and gh and the Debian packages from their apt repositories
# at build time.

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

WORKDIR /app/agents/valkey-glide-review
COPY agents/valkey-glide-review/package.json agents/valkey-glide-review/package-lock.json ./
RUN npm ci

COPY agents/common/src/ /app/agents/common/src/
COPY agents/valkey-glide-review/tsconfig.json ./
COPY agents/valkey-glide-review/src/ ./src/
# Dev dependencies are dropped by a production npm ci, not npm prune:
# prune resolves the tree again and stops on ERESOLVE, because
# @strands-agents/sdk declares an optional peer of openai 6 and the agent
# uses openai 7. npm ci installs the lockfile as it is.
RUN npx tsc -p tsconfig.json \
 && npm ci --omit=dev

FROM base AS runtime

ENV JAVA_HOME=/opt/java \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/opt/java/bin:/usr/local/cargo/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# build-essential, pkg-config and libssl-dev serve Rust build scripts.
RUN mkdir -p -m 0755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      git gh \
      build-essential pkg-config libssl-dev libc6-dev \
      ripgrep jq \
      unzip xz-utils \
      python3 \
 && rm -rf /var/lib/apt/lists/*

# JDK 11. java/build.gradle pins the Gradle toolchain to Java 11 and
# Debian bookworm has no JDK 11 package, so this is Temurin from Adoptium.
ARG JDK_VERSION=11.0.32.1+1
ARG JDK_SHA256_ARM64=f27033e6f7523c1b0b2565a78e9c0e0abe5596a854ce00ca04ec1b06ece7a935
ARG JDK_SHA256_AMD64=5c3f68887c325d36d852ba534303e1f5f1f5cae7d6cc1e951d73e0d8e98a058d
RUN case "$(dpkg --print-architecture)" in \
      arm64) arch=aarch64 sha="$JDK_SHA256_ARM64" ;; \
      amd64) arch=x64 sha="$JDK_SHA256_AMD64" ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/jdk.tar.gz \
      "https://github.com/adoptium/temurin11-binaries/releases/download/jdk-${JDK_VERSION/+/%2B}/OpenJDK11U-jdk_${arch}_linux_hotspot_${JDK_VERSION/+/_}.tar.gz" \
 && echo "${sha}  /tmp/jdk.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/java \
 && tar -xzf /tmp/jdk.tar.gz -C /opt/java --strip-components=1 \
 && rm /tmp/jdk.tar.gz \
 && java -version

# protoc. The Java build generates its protobuf classes with it and
# requires 29 or newer. 29.6 matches the protobuf-java runtime that
# java/client/build.gradle depends on.
ARG PROTOC_VERSION=29.6
ARG PROTOC_SHA256_ARM64=2594ff4fcae8cb57310d394d0961b236190ad9c5efbfdf1f597ea471d424fe79
ARG PROTOC_SHA256_AMD64=48785a926e73ffa3f68e2f22b14e7b849620c7a1d36809ac9249a5495e280323
RUN case "$(dpkg --print-architecture)" in \
      arm64) arch=aarch_64 sha="$PROTOC_SHA256_ARM64" ;; \
      amd64) arch=x86_64 sha="$PROTOC_SHA256_AMD64" ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/protoc.zip \
      "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-${arch}.zip" \
 && echo "${sha}  /tmp/protoc.zip" | sha256sum -c - \
 && unzip -q -o /tmp/protoc.zip -d /usr/local bin/protoc 'include/*' \
 && chmod 0755 /usr/local/bin/protoc \
 && chmod -R a+rX /usr/local/include/google \
 && rm /tmp/protoc.zip \
 && protoc --version

# Go, from the release tarball because Debian's lags behind.
ARG GO_VERSION=1.23.2
ARG GO_SHA256_ARM64=f626cdd92fc21a88b31c1251f419c17782933a42903db87a174ce74eeecc66a9
ARG GO_SHA256_AMD64=542d3c1705f1c6a1c5a80d5dc62e2e45171af291e755d591c5e6531ef63b454e
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      arm64) sha="$GO_SHA256_ARM64" ;; \
      amd64) sha="$GO_SHA256_AMD64" ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" \
 && echo "${sha}  /tmp/go.tar.gz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tar.gz \
 && rm /tmp/go.tar.gz \
 && go version

# Rust through rustup, with clippy for `cargo clippy`. The agent user
# downloads crates into CARGO_HOME at run time, so it must be writable.
ARG RUST_TOOLCHAIN=stable
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --component clippy \
          --default-toolchain "${RUST_TOOLCHAIN}" \
 && chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME" \
 && rustc --version && cargo --version && cargo clippy --version

# zig and cargo-zigbuild. java/client/build.gradle builds the JNI
# library with `cargo zigbuild` on Linux to target an old glibc.
ARG ZIG_VERSION=0.17.0
ARG ZIG_SHA256_ARM64=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8
ARG ZIG_SHA256_AMD64=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026
ARG CARGO_ZIGBUILD_VERSION=0.23.4
ARG CARGO_ZIGBUILD_SHA256_ARM64=25cf2cdc6cde848b33a761ff2cf46d1efe6ba7e1adfc4b6f3ee2d570cacb5419
ARG CARGO_ZIGBUILD_SHA256_AMD64=6b69963040818ca1ef573d8135a95aa902e17cf7f873c32c6426642dadfe7f59
RUN case "$(dpkg --print-architecture)" in \
      arm64) arch=aarch64 zig_sha="$ZIG_SHA256_ARM64" czb_sha="$CARGO_ZIGBUILD_SHA256_ARM64" ;; \
      amd64) arch=x86_64 zig_sha="$ZIG_SHA256_AMD64" czb_sha="$CARGO_ZIGBUILD_SHA256_AMD64" ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/zig.tar.xz \
      "https://ziglang.org/download/${ZIG_VERSION}/zig-${arch}-linux-${ZIG_VERSION}.tar.xz" \
 && echo "${zig_sha}  /tmp/zig.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/zig \
 && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 \
 && ln -s /opt/zig/zig /usr/local/bin/zig \
 && curl -fsSL -o /tmp/cargo-zigbuild.tar.xz \
      "https://github.com/rust-cross/cargo-zigbuild/releases/download/v${CARGO_ZIGBUILD_VERSION}/cargo-zigbuild-${arch}-unknown-linux-gnu.tar.xz" \
 && echo "${czb_sha}  /tmp/cargo-zigbuild.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/cargo-zigbuild.tar.xz -C /usr/local/bin --strip-components=1 \
      "cargo-zigbuild-${arch}-unknown-linux-gnu/cargo-zigbuild" \
 && rm /tmp/zig.tar.xz /tmp/cargo-zigbuild.tar.xz \
 && zig version && cargo-zigbuild --version

# The agent runs as an unprivileged user that owns the clone, so git
# needs no safe.directory exception. The agent's code goes in a
# root-owned directory: the agent user can read it but not change it.
RUN useradd --create-home --uid 1000 agent \
 && install -d -o agent -g agent /workspace \
 && install -d /app/agents/valkey-glide-review
USER agent

# Each run fetches the pull request into this clone instead of cloning
# from scratch. blob:limit=1m keeps every tree and every blob up to 1 MB,
# so blame and log -S run locally. The large artifacts in the history
# are fetched only if something asks for them.
RUN git clone --filter=blob:limit=1m https://github.com/valkey-io/valkey-glide.git /workspace/valkey-glide

WORKDIR /app/agents/valkey-glide-review
COPY --from=build /app/agents/valkey-glide-review/package.json ./
COPY --from=build /app/agents/valkey-glide-review/node_modules/ ./node_modules/
COPY --from=build /app/agents/valkey-glide-review/dist/ ./dist/

# NODE_ENV stays unset. Under NODE_ENV=production, npm ci in node/ would
# skip the dev dependencies the binding's build needs.
ENV WORKSPACE_ROOT=/workspace/valkey-glide

CMD ["node", "--enable-source-maps", "/app/agents/valkey-glide-review/dist/valkey-glide-review/src/agent.js"]
