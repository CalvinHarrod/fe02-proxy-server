const express = require('express');
const CryptoJS = require('crypto-js');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const app = express();

const secretKey = '713A28EFA163EB37B90C713422C8BCD5C4D7426E3366A5987B2A3CDB01E1420620896389C04E9C38049751FA3F092E24474B9A51CA65F71E555AA74949A2CAA2';

// create a write stream (in append mode)
var accessLogStream = fs.createWriteStream(path.join(__dirname, 'access.log'), { flags: 'a' })

// setup the logger
app.use(morgan('combined', { stream: accessLogStream }))

app.use(
  '/',
  createProxyMiddleware({
    target: 'http://192.168.42.12:8080',
    changeOrigin: true,
    ws: true, // Enable WebSocket proxying
    router: function(req) {
      const encryptedUrl = req.url.substring(1); // remove the leading '/'
      const bytes = CryptoJS.AES.decrypt(encryptedUrl, secretKey);
      const decryptedUrl = bytes.toString(CryptoJS.enc.Utf8);
      console.log(`Decrypted URL: ${decryptedUrl}`); // Log decrypted URL
      return decryptedUrl;
    }
  })
);

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
