# Story Narrator Enhanced - Node.js + Python/Kokoro
FROM node:20-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    espeak-ng \
    libsndfile1 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install

# Copy application source
COPY src/ ./src/
COPY src/routes/ ./src/routes/

# Install Kokoro Python dependencies
COPY kokoro/requirements.txt ./kokoro/
RUN pip3 install --no-cache-dir --break-system-packages -r kokoro/requirements.txt

# Copy Kokoro TTS server
COPY kokoro/tts_server.py ./kokoro/

# Create directories for temp files
RUN mkdir -p /tmp/epub-convert /tmp/kokoro-audio

# Expose ports
# 8080: Node.js Express (main service)
# 8081: Python Kokoro TTS
EXPOSE 8080 8081

# Environment variables
ENV NODE_ENV=production
ENV KOKORO_PORT=8081
ENV KOKORO_HOST=localhost
ENV PORT=8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start both services using a wrapper script
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]