const express = require('express');
const httpProxy = require('http-proxy');
const { format } = require('date-fns');

const app = express();
const proxy = httpProxy.createProxyServer({});

const fs = require('fs');

function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}${month}${day} ${hours}:${minutes}:${seconds}`;
}

function logToFile(message) {
  const logFilePath = 'sso-proxy-server.js.log';
  const logFileBackupPath = 'sso-proxy-server.js.log.blk';
  const maxLogFileSize = 100 * 1024 * 1024; // 100MB

  const timestamp = getTimestamp();
  const logMessage = `${timestamp} - ${message}\n`;

  // Check the size of the log file
  fs.stat(logFilePath, (err, stats) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Failed to get log file stats:', err);
      return;
    }

    if (stats && stats.size >= maxLogFileSize) {
      // Rotate the log file
      fs.copyFile(logFilePath, logFileBackupPath, (copyErr) => {
        if (copyErr) {
          console.error('Failed to copy log file:', copyErr);
          return;
        }

        fs.truncate(logFilePath, 0, (truncateErr) => {
          if (truncateErr) {
            console.error('Failed to truncate log file:', truncateErr);
            return;
          }

          // Append the new log message after rotation
          fs.appendFile(logFilePath, logMessage, (appendErr) => {
            if (appendErr) {
              console.error('Failed to write to log file:', appendErr);
            }
          });
        });
      });
    } else {
      // Append the log message directly
      fs.appendFile(logFilePath, logMessage, (appendErr) => {
        if (appendErr) {
          console.error('Failed to write to log file:', appendErr);
        }
      });
    }
  });
}

logToFile('Starting server setup');

app.head('/', (req, res) => {
  logToFile('Received HEAD request for health check');
  // Check the health of the server
  // This is a simple example, you should replace it with your actual health check
  const serverIsHealthy = true;

  if (serverIsHealthy) {
    logToFile('Server is healthy');
    res.status(200).end();
  } else {
    logToFile('Server is not healthy');
    res.status(500).end();
  }
});

app.use((req, res) => {
  logToFile('Proxying request to: ' + 'http://192.168.42.11:8080' + req.url);
  // Forward the request to the target server
  proxy.web(req, res, { target: 'http://192.168.42.11:8080' });
});

proxy.on('proxyReq', function(proxyReq, req, res, options) {
  logToFile('Request sent to target server');
});

proxy.on('proxyRes', function(proxyRes, req, res) {
  logToFile('Received response from target server');
});

const server = app.listen(11380, () => {
  logToFile('Server listening on http://eform.tvb.com.hk:11380');
});

server.on('upgrade', (req, socket, head) => {
  logToFile('Handling WebSocket upgrade');
  proxy.ws(req, socket, head);
});

logToFile('Server setup complete');