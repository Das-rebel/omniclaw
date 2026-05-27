FROM python:3.11-slim

WORKDIR /app

# Install minimal deps for the simple keyword search
COPY requirements.txt .
RUN pip install --no-cache-dir flask==3.1.0 gunicorn==24.0.0 google-cloud-storage==2.18.2

# Copy app files
COPY serve_vault_search.py service.py ./

ENV PORT=8080

# gunicorn handles the PORT env var correctly
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "180", "service:application"]