FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY seed ./seed
ENV PORT=8080 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/server.ts"]
