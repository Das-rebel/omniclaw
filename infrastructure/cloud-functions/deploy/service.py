from serve_vault_search import app
application = app

# Ensure Flask uses the PORT env var (Cloud Run sets PORT=8080)
if __name__ == "__main__":
    import os
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)