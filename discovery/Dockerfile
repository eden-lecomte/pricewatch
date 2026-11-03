FROM node:22-alpine

RUN apk add --no-cache curl \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /discovery
COPY prompt.md run.sh ./
RUN chmod +x run.sh && chown -R node:node /discovery
USER node

CMD ["/discovery/run.sh"]
