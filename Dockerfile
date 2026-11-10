# Container image for PAM (web + worker) with the engines' system tools. NOT built or tested in the development
# environment (no Docker daemon was available); the same tool set was installed and exercised natively there.
FROM node:24.22.2-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ca-certificates poppler-utils tesseract-ocr tesseract-ocr-eng ffmpeg libreoffice-writer-nogui pandoc \
      imagemagick librsvg2-bin libimage-exiftool-perl sox fluidsynth fluid-soundfont-gm espeak-ng clamav \
      apertium apertium-eng-spa python3 python3-numpy python3-pip fonts-dejavu-core fonts-noto-core zip unzip postgresql-client \
    && pip3 install --break-system-packages pocketsphinx==5.1.1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json engines.lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund && node scripts/bootstrap-engines.mjs
COPY . .
ENV HOST=0.0.0.0 PORT=8080 PAM_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "src/app/main.ts", "serve"]
