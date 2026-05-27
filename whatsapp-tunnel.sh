#!/bin/bash
# WhatsApp SSH tunnel - keeps Mac's WhatsApp relay accessible via VPS
KEY_FILE="$HOME/.ssh/vps_key"
VPS_HOST="35.200.164.45"
VPS_PORT="8091"
LOCAL_PORT="8091"
LOG_FILE="/tmp/whatsapp-tunnel.log"

while true; do
  echo "[$(date)] Starting tunnel..." >> "$LOG_FILE"
  
  ssh -o StrictHostKeyChecking=no \
      -o ConnectTimeout=10 \
      -o TCPKeepAlive=yes \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=8 \
      -o ExitOnForwardFailure=yes \
      -i "$KEY_FILE" \
      -R "$VPS_PORT":localhost:"$LOCAL_PORT" \
      Subho@"$VPS_HOST" -N >> "$LOG_FILE" 2>&1
  
  echo "[$(date)] Tunnel dropped, reconnecting in 3s..." >> "$LOG_FILE"
  sleep 3
done
