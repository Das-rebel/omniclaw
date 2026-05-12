FROM python:3.11-slim

WORKDIR /app

# Install only what's needed - torch/CLIP already in base image
RUN pip install --no-cache-dir flask==3.1.0 gunicorn==24.0.0

# Copy application files
COPY serve_vault_search.py service.py requirements.txt semantic_dashboard.html ./

# learning_base already in container from original build
# No need to re-copy it

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "service:application"]
