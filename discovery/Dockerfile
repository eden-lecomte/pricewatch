FROM node:22-alpine

RUN npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /discovery
COPY prompt.md run.sh ./
COPY pw.mjs /usr/local/bin/pw
RUN chmod +x run.sh /usr/local/bin/pw && chown -R node:node /discovery
USER node

CMD ["/discovery/run.sh"]
