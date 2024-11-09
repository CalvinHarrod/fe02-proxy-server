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
  const logFilePath = 'proxy-server.js.log';
  const logFileBackupPath = 'proxy-server.js.log.blk';
  const maxLogFileSize = 100 * 1024 * 1024; // 100MB

  const timestamp = getTimestamp();
  const logMessage = `${timestamp} - ${message}\n`;

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
app.head('/', (req, res) => {
  // Check the health of the server
  // This is a simple example, you should replace it with your actual health check
  const serverIsHealthy = true;

  if (serverIsHealthy) {
    res.status(200).end();
  } else {
    res.status(500).end();
  }
});

app.use((req, res, next) => {
  const isPreload = req.headers['x-purpose'] === 'preview' || req.headers['purpose'] === 'prefetch';

  if (isPreload) {
    logToFile('Ignoring preload request');
    res.status(204).end(); // Respond with 204 No Content
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const mobile = url.searchParams.get('mobile');

  if (req.method === 'GET' && url.pathname === '/eform-application/form_main') {
    logToFile('Mobile number: ' + mobile);

    fs.readFile('token-db.json', 'utf8', (err, data) => {
      if (err) {
        logToFile(err);
        return res.status(500).end();
      }

      const tokens = JSON.parse(data).tokens;
      const token = tokens.find(token => {
        const tokenExpiry = new Date(token.expiry);
        const now = new Date();

        return token.mobile === mobile && token.password === true && tokenExpiry > now;
      });

      if (!token) {
        logToFile('No Token or No Mobile Number');
        return res.redirect('https://eform.tvb.com.hk');
      } else {
        logToFile('Token.mobile: ' + token.mobile);
        logToFile('Token.password: ' + token.password);
        logToFile('Token.expiry: ' + token.expiry);
        logToFile('Current time: ' + format(new Date(), 'yyyy-MM-dd HH:mm'));
        logToFile('Authenticated, proxying request to target server');
        next();
      }
    }); // This closes the fs.readFile callback
  } else {
    next(); // Ensure middleware calls next() if not handling the request
  }
}); // This closes the app.use for the GET request handling

app.use((req, res) => {
  logToFile('Proxying request to: ' + 'http://192.168.42.11:8080' + req.url);
  proxy.web(req, res, { target: 'http://192.168.42.11:8080' });
});

proxy.on('proxyReq', function(proxyReq, req, res, options) {
  logToFile('Request sent to target server');
});

proxy.on('proxyRes', function(proxyRes, req, res) {
  logToFile('Received response from target server');
});

const server = app.listen(9700, () => {
  logToFile('Server listening on http://localhost:9700');
});

server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head);
});