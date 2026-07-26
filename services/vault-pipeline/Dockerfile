FROM python:3.12-slim

WORKDIR /app

# Install system dependencies and gunicorn
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install gunicorn for production server
RUN pip install --no-cache-dir gunicorn

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Expose port
EXPOSE 8080

# Run with gunicorn (production)
CMD ["gunicorn", "--bind", ":8080", "--workers", "1", "--threads", "4", "chroma_search_api:app"]
