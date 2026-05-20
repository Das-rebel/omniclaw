#!/bin/bash
# Docker Entrypoint - Start both Node.js and Kokoro Python service

echo "Starting Kokoro TTS server..."
cd /app/kokoro
python3 tts_server.py &
KOKORO_PID=$!

echo "Waiting for Kokoro to initialize..."
sleep 5

echo "Starting Story Narrator Node.js service..."
cd /app
node src/index.js &
NODE_PID=$!

# Handle shutdown gracefully
shutdown() {
    echo "Shutting down services..."
    kill $KOKORO_PID 2>/dev/null
    kill $NODE_PID 2>/dev/null
    exit 0
}

trap shutdown SIGTERM SIGINT

# Keep container running
echo "Services started. PID Kokoro=$KOKORO_PID, Node=$NODE_PID"
wait