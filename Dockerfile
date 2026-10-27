FROM node:25.9.0-slim

ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=4173
ENV HAKU_DB_PATH=/var/lib/haku/haku.sqlite

WORKDIR /app
COPY --chown=node:node . /app
RUN mkdir -p /var/lib/haku && chown node:node /var/lib/haku

VOLUME ["/var/lib/haku"]
USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4173/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
