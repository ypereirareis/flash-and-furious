# syntax=docker/dockerfile:1

# Alpine release shared by every stage: the node binary copied into the runtime image must come
# from an image built on the same release (same musl and libstdc++).
ARG ALPINE_VERSION=3.24

# ---- Stage 1: npm dependencies ----
# Only depends on package.json / package-lock.json: this stage is reused from the
# build cache as long as they don't change (editing the code never reinstalls packages).
# Alpine (musl) rather than Debian: the runtime image is about half the size, with the same
# sharp/libvips version and a more recent gphoto2.
FROM node:22-alpine${ALPINE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci: installs exactly the versions from package-lock.json.
# The npm download cache is kept between builds (BuildKit cache mount), outside the image.
# sharp ships prebuilt binaries for several targets: only the musl one is used here, the glibc
# and WebAssembly ones are removed (whatever the CPU architecture), then sharp is test-loaded.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/@img/sharp-wasm32 node_modules/@img/sharp-linux-* node_modules/@img/sharp-libvips-linux-* \
 && node -e "require('sharp')"

# ---- Stage 2: Node.js binary ----
FROM node:22-alpine${ALPINE_VERSION} AS node

# ---- Stage 3: runtime image ----
# Plain Alpine + the node binary only: no npm, npx, corepack, yarn or C headers in the image
# (only needed to install packages, in stage 1), which shrinks it and its attack surface.
# Deleting them from the node image instead would not save anything: they would stay in its layers.
FROM alpine:${ALPINE_VERSION} AS runtime

# libstdc++/libgcc: needed by node. gphoto2: camera control over USB (PTP), no firmware writes.
# tzdata: local time (TZ) in file names and on frames. font-dejavu: text on frames.
# util-linux-misc (mountpoint) and setpriv: photos folder checks in the entrypoint.
# Package versions are not pinned: exact versions disappear from the Alpine repositories with
# every security update, which would break the build. ALPINE_VERSION fixes the Alpine release.
# hadolint ignore=DL3018
RUN apk add --no-cache libstdc++ libgcc gphoto2 tzdata font-dejavu util-linux-misc setpriv
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
# application code (feature modules in src/features/: delete a folder to remove a module)
COPY src ./src
# Checks and prepares the photos folder on every start (idempotent), then runs the CMD
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    PHOTOS_DIR=/app/photos \
    CONFIG_DIR=/app/config

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server/index.js"]
