# Debian slim rather than Alpine: Claude Code needs bash and is best supported on glibc.
FROM node:22-slim

ENV SHELL=/bin/bash

RUN npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /discovery
COPY prompt.md run.sh ./
COPY pw.mjs /usr/local/bin/pw
RUN chmod +x run.sh /usr/local/bin/pw && chown -R node:node /discovery
USER node

CMD ["/discovery/run.sh"]
