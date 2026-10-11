# The wiki with its render check: Playwright's Chromium is installed in the image, so code
# is opened in a real browser before it is accepted, the same as a developer's machine.
FROM node:24-bookworm-slim
WORKDIR /app
ENV PORT=8080 DATA_DIR=/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY src ./src
COPY seed ./seed
RUN mkdir -p /data && chown -R node:node /data /ms-playwright
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/server.ts"]
