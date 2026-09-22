FROM node:22-bookworm-slim

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
ENV HOST=0.0.0.0 PORT=8787 STATE_FILE=/app/data/sync-state.json
ENV SYNC_WRITE_ENABLED=false ASSIGNMENT_SCHEDULE_ENABLED=false
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
