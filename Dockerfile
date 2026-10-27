FROM node:25.9.0-slim

ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=4183
ENV HAKU_DB_PATH=/var/lib/haku/haku.sqlite

WORKDIR /app
COPY --chown=node:node . /app
RUN mkdir -p /var/lib/haku && chown node:node /var/lib/haku

VOLUME ["/var/lib/haku"]
USER node
EXPOSE 4183

# Probe the port the server actually listens on; with host networking a fixed port could hit another service.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4183) + '/api/health').then(r => r.json()).then(b => process.exit(b && b.ok === true ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
