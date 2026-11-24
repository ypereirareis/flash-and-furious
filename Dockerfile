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
RUN apt-get update \
 && apt-get install -y --no-install-recommends gphoto2 ca-certificates tzdata fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public
COPY frames ./frames

ENV NODE_ENV=production \
    PORT=3000 \
    PHOTOS_DIR=/app/photos

EXPOSE 3000
CMD ["node", "server/index.js"]
