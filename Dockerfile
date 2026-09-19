FROM node:22-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install --with-deps chromium
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev && chmod -R a+rX /ms-playwright
ENV NODE_ENV=production PORT=8080
USER node
CMD ["node", "dist/src/server.js"]
