const express = require('express');
const CryptoJS = require('crypto-js');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

const secretKey = '713A28EFA163EB37B90C713422C8BCD5C4D7426E3366A5987B2A3CDB01E1420620896389C04E9C38049751FA3F092E24474B9A51CA65F71E555AA74949A2CAA2';

app.get('/:encryptedUrl', (req, res, next) => {
  const encryptedUrl = req.params.encryptedUrl;
  const bytes = CryptoJS.AES.decrypt(encryptedUrl, secretKey);
  const decryptedUrl = bytes.toString(CryptoJS.enc.Utf8);

  // Set the new URL in the req object
  req.url = decryptedUrl;

  // Pass the request to the proxy middleware
  next();
});

app.use(
  '/',
  createProxyMiddleware({
    target: 'http://192.168.42.12:8080',
    changeOrigin: true,
    ws: true, // Enable WebSocket proxying
  })
);
