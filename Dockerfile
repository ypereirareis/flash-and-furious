FROM node:22-bookworm-slim

# gphoto2: camera control over USB (PTP). No firmware writes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gphoto2 ca-certificates tzdata fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci: installs exactly the versions from package-lock.json
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY frames ./frames

ENV NODE_ENV=production \
    PORT=3000 \
    PHOTOS_DIR=/app/photos

EXPOSE 3000
CMD ["node", "server/index.js"]
