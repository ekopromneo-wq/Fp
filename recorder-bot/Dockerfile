FROM mcr.microsoft.com/playwright:v1.49.1-jammy

RUN apt-get update \
    && apt-get install -y --no-install-recommends pulseaudio ffmpeg wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8100

CMD ["npm", "start"]
