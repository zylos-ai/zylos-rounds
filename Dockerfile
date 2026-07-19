# zylos-rounds standalone server image.
# Data (config.json, SQLite DB, logs) lives in /data — mount a volume there.
# First start prints the generated admin password and service token to the log.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV ROUNDS_HOME=/data \
    ROUNDS_BIND=0.0.0.0

EXPOSE 3478
VOLUME /data

CMD ["node", "src/index.js"]
