FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends pulseaudio ffmpeg wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev \
    && npx playwright install --with-deps chromium

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8100

CMD ["npm", "start"]
