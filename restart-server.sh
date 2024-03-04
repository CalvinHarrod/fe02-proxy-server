#!/bin/bash

echo "Stopping the token-server.js process..."
pkill -f token-server.js

echo "Waiting for 2 seconds..."
sleep 2

echo "Starting the token-server.js process..."
nohup node token-server.js &

echo "Token-server.js has been restarted."

netstat -tupln | grep 7777
