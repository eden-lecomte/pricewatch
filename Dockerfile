FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
