FROM python:3.11-slim

WORKDIR /app

# Install from requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app files
COPY serve_vault_search.py service.py ./

ENV PORT=8080

# Use gunicorn with multiple workers for production
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "120", "service:application"]