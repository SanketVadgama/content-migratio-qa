# Playwright base image includes Chromium + system deps
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=3099
ENV RENDER_SERVICE_TOKEN=""

EXPOSE 3099

CMD ["node", "src/server.js"]
