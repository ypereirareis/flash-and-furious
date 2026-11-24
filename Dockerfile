# syntax=docker/dockerfile:1

# ---- Stage 1: npm dependencies ----
# Only depends on package.json / package-lock.json: this stage is reused from the
# build cache as long as they don't change (editing the code never reinstalls packages).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci: installs exactly the versions from package-lock.json.
# The npm download cache is kept between builds (BuildKit cache mount), outside the image.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---- Stage 2: runtime image ----
FROM node:22-bookworm-slim AS runtime

# gphoto2: camera control over USB (PTP). No firmware writes.
# Debian package versions are not pinned: exact versions disappear from the archive with every
# security update, which would break the build. The base image tag fixes the Debian release.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends gphoto2 ca-certificates tzdata fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# npm, npx and corepack are only needed to install packages (stage 1), not to run the app:
# removing them shrinks the image and its attack surface (npm bundles many dependencies).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public
COPY frames ./frames
# Checks and prepares the photos folder on every start (idempotent), then runs the CMD
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    PHOTOS_DIR=/app/photos \
    CONFIG_DIR=/app/config

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
