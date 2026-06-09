# RealFast Job Alert Service
# Node.js 22 Alpine for minimal image size

FROM node:22-alpine

WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY *.js ./
COPY .env.example .env

# Create log directory
RUN mkdir -p /app/logs

# Expose port (for health checks)
EXPOSE 8080

# Run as non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run the service
CMD ["node", "index.js"]