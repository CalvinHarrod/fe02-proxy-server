const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SamlStrategy = require('passport-saml').Strategy;
const fs = require('fs');
const FileStore = require('session-file-store')(session);
const xmlparser = require('express-xml-bodyparser');
const bodyParser = require('body-parser');
const uuid = require('uuid');
const moment = require('moment-timezone');
const basicAuth = require('express-basic-auth');
const axios = require('axios');

let expiryValue = 1;
let expiryUnit = 'hours';

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
  const logFilePath = 'sso-server.js.log';
  const logFileBackupPath = 'sso-server.js.log.blk';
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

logToFile('Modules imported');

const app = express();

app.use(xmlparser());
app.use(bodyParser.urlencoded({ extended: true }));

const { createProxyMiddleware } = require('http-proxy-middleware');

const proxy = createProxyMiddleware({
  target: 'http://192.168.42.11:8080',
  changeOrigin: true,
  pathRewrite: {
    '^/eform-application': '/eform-application'
  }
});

app.use('/eform-application', proxy);

let mockDatabase = {};
app.use(session({
  secret: 'redsystem',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 },
}));

setInterval(() => {
  const now = moment().tz('Asia/Hong_Kong').format('YYYYMMDD HH:mm:ss');
  for (let sessionId in mockDatabase) {
    if (mockDatabase[sessionId].expiryTime < now) {
      delete mockDatabase[sessionId];
    }
  }
}, 60000);

app.get('/readDatabase',
  basicAuth({
    users: { 'admin': 'redformAdmin' },
    challenge: true
  }),
  function(req, res) {
    res.send(mockDatabase);
  }
);

app.use(passport.initialize());
app.use(passport.session());

logToFile('Express app created and Passport initialized');

const samlStrategy = new SamlStrategy(
  {
    path: '/IdP/SSO',
    entryPoint: 'https://login.microsoftonline.com/ca1293ac-d322-43f4-ae3b-e18e5fa51fb9/saml2',
    issuer: 'https://eform.tvb.com.hk:8888/IdP',
    protocol: 'https://',
    cert: fs.readFileSync("/etc/nginx/node-server/sso-cert/RED-Form Base64.cer", 'utf-8'),
    privateCert: fs.readFileSync("/etc/nginx/node-server/sso-cert/https-cert/star_tvb_com_hk.pem", 'utf-8'),
  },
  function(profile, done) {
    logToFile('Profile: ' + JSON.stringify(profile));
    return done(null, profile);
  }
);

app.head('/', function(req, res) {
  res.sendStatus(200);
});

logToFile('SAML strategy created');

passport.use(samlStrategy);

logToFile('SAML strategy used with Passport');

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

async function authenticateEmail(email) {
  try {
    const response = await axios.get(`http://192.168.42.11:8080/eform-application/ajax/checkEmail?email=${email}`, {
      timeout: 5000
    });
    if (response.data === true) {
      return true;
    } else {
      logToFile(`Response data is not 'True', it is: ${response.data}`);
      return false;
    }
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      logToFile('The request timed out: ' + error.message);
      throw new Error('Request timed out');
    } else {
      logToFile('An error occurred during the HTTP request: ' + error);
    }
    return false;
  }
}

app.get('/login',
  function(req, res, next) {
    const sessionId = req.sessionID;
    logToFile('Session ID: ' + sessionId);
    if (req.isAuthenticated()) {
      logToFile('Already authenticated, redirecting to home');
      if (mockDatabase[sessionId]) {
        mockDatabase[sessionId].startTime = moment().tz('Asia/Hong_Kong').format('YYYYMMDD HH:mm:ss');
        mockDatabase[sessionId].expiryTime = moment().add(expiryValue, expiryUnit).tz('Asia/Hong_Kong').format('YYYYMMDD HH:mm:ss');
      }
      let email = mockDatabase[req.sessionID]?.email;
      let redirectUrl = `/eform-application/form_main?email=${email}`;
      logToFile('Redirecting to: ' + redirectUrl);
      res.redirect(redirectUrl);
    } else {
      next();
    }
  },
  passport.authenticate('saml', { failureRedirect: '/login', failureFlash: true })
);

app.post('/IdP/SSO',
  passport.authenticate('saml', { failureRedirect: '/', failureFlash: true }),
  async function(req, res) {
    logToFile('Processing SAML response');
    const sessionId = req.sessionID;
    const email = req.user['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'];
    const AAD = req.user['http://schemas.microsoft.com/identity/claims/objectidentifier'];

    logToFile('Check Point 1');

    if (await authenticateEmail(email)) {
      logToFile('Check Point 2');
      mockDatabase[sessionId] = {
        startTime: moment().tz('Asia/Hong_Kong').format('YYYYMMDD HH:mm:ss'),
        expiryTime: moment().add(1, 'hours').tz('Asia/Hong_Kong').format('YYYYMMDD HH:mm:ss'),
        email: email,
        AAD: AAD
      };
      logToFile('Check Point 3');
      res.redirect(`/eform-application/form_main?email=${email}`);
    } else {
      logToFile('Check Point 4');
      res.send(`Your email ${email} is invalid in RED SYSTEM, please try to mobile access again`);
    }
  }
);

logToFile('SAML response route created');

app.listen(8888, () => {
  logToFile('Server listening on port 8888');
});