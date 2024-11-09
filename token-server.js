// declare the required modules ------------------------------------------------------------------------------
require('dotenv').config();

const secretKey = process.env.SECRET_KEY;
const { format } = require('date-fns');
// Add this line at the top of your file
const express = require('express');

const jwt = require('jsonwebtoken');
const cors = require('cors');
const url = require('url');
const axios = require('axios');

const bodyParser = require('body-parser');

const http = require('http');

// Declare the backend server URL
const BASE_URL = 'http://192.168.42.11:8080';

// Declare the server URL and port
const REDIRECT_SERVER_URL = 'http://10.161.168.12:9700';

const listenPort = 11280;

// Create a new lowdb instance
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const fs = require('fs');
const fsp = require('fs').promises;

//this part for redirect purpose
const httpProxy = require('http-proxy');
const proxy = httpProxy.createProxyServer({});

const adapter = new FileSync('token-db.json');
const { log } = require('console');

// Redis ################################################
const Redis = require('ioredis');
// Connect to Redis with default host and port
const redis = new Redis();

// Error handling
redis.on('error', (error) => {
  console.error('Redis connection error:', error);
});

// Optionally, export the Redis client for use in other modules
module.exports = redis;
// Redis ################################################

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(express.json());

let tokenExpiration = 60 * 60 * 1000; // 60 minutes in milliseconds

// Convert to number if necessary
if (typeof tokenExpiration === 'string') {
  tokenExpiration = Number(tokenExpiration);
}

// Check if tokenExpiration is a number
if (isNaN(tokenExpiration)) {
  console.error('Invalid token expiration');
  return;
}
// declare the required modules ------------------------------------------------------------------------------

// Prepare the lowdb adapter ----------------------------------------------------------------------

// Check if the file exists and is not empty
if (!fs.existsSync('token-db.json') || fs.readFileSync('token-db.json', 'utf8').trim() === '') {
  // If file does not exist or is empty, initialize it with a default value
  fs.writeFileSync('token-db.json', JSON.stringify({ tokens: [] }, null, 2), 'utf8');
}

let db;

try {
  // Try to load the database
  db = low(adapter);
} catch (error) {
  // If an error occurred (e.g., the JSON file is invalid), initialize it with default values
  fs.writeFileSync('token-db.json', JSON.stringify({ tokens: [] }, null, 2), 'utf8');
  db = low(adapter);
}
db.defaults({ tokens: [] })
  .write();
// Prepare the lowdb adapter ----------------------------------------------------------------------

// Function Zone ############################################################################################################
//###########################################################################################################################

//Logging define
async function logToFile(message) {
  const timestamp = format(new Date(), 'yyyyMMdd HH:mm:ss');
  const logMessage = `${timestamp} ${message}\n`;
  await fsp.writeFile('token-server.log', logMessage, { encoding: 'utf8', flag: 'a' });
}

//-----------------------------------------------------------------------------------------------------------------------------
// Define the isTokenExpired function
function isTokenExpired(token) {
  // Retrieve the token data from the database
  const tokenData = db.get('tokens').find({ token }).value();

  if (!tokenData) {
    return true;
  }

  // Check if the token has expired
  return Date.now() > new Date(tokenData.expiry).getTime();
}
//-----------------------------------------------------------------------------------------------------------------------------

// Avoic attrack from the same IP /////////////////////////////////////////////////////////////////////////////////////////////
// counter does not exceed 3 in 30s, auto reset every 30s
//failed 2 times, suspend 5 mins, auto reset after 5 mins

async function isRateLimited(ip, zone) {
  const maxRequests = 4; // Maximum requests allowed within the rate limit window
  const maxFailures = 2; // Maximum failures allowed before suspension
  const rateLimitWindowSeconds = 60; // Window for rate limiting (60 seconds)
  const suspensionSeconds = 120; // Suspension time (2 minutes)

  const rateLimitKey = `rate_limit:${ip}`;
  const failureKey = `failure_count:${ip}`; // Key to track failure count
  const suspendKey = `suspend:${ip}`;
  const isSuspended = await redis.get(suspendKey);

  // Check if the IP is currently suspended
  if (isSuspended) {
    logToFile(`${zone} - IP: ${ip}, Access denied due to suspension. Count: N/A, Failures: N/A`);
    return true; // Deny access if suspended
  }

  // If not suspended, proceed with rate limiting checks
  const currentCount = await redis.get(rateLimitKey);
  const currentFailures = await redis.get(failureKey) || 0; // Get current failures or default to 0

  // Initial stage 1st
  if (currentCount === null) {
    // First request or window has reset
    await redis.set(rateLimitKey, 1, 'EX', rateLimitWindowSeconds);
    await redis.set(failureKey, 0, 'EX', rateLimitWindowSeconds); // Reset failure count on new window
    logToFile(`${zone} - IP: ${ip}, New entry, count set to 1, Failures: 0`);
    return false; // Allow access, count set to 1
  } else {
    const count = parseInt(currentCount, 10);
    if (count < maxRequests) {
      await redis.incr(rateLimitKey);
      logToFile(`${zone} - IP: ${ip}, Incremented, current count: ${count + 1}, Failures: ${currentFailures}`);
      return false; // Allow access, count incremented
    } else {
      // Exceeded maxRequests, check for failure handling
      const failures = parseInt(currentFailures, 10) + 1;
      if (failures >= maxFailures) {
        // Suspend IP after reaching maxFailures
        await redis.set(suspendKey, true, 'EX', suspensionSeconds);
        logToFile(`${zone} - IP: ${ip}, Suspended for 5 minutes due to exceeding failure attempts. Count: ${count}, Failures: ${failures}`);
        return true; // Deny access, failure limit exceeded
      } else {
        // Increment failure count and deny access
        await redis.set(failureKey, failures, 'EX', rateLimitWindowSeconds);
        logToFile(`${zone} - IP: ${ip}, Failure recorded, current failure count: ${failures}. Count: ${count}`);
        return true; // Deny access, within failure tolerance
      }
    }
  }
}
//-----------------------------------------------------------------------------------------------------------------------------

// Reset counter to '0' by IP /////////////////////////////////////////////////////////////////////////////////////////////////
async function resetAllCountsByIP(ip) {
  const keysToDelete = [
    `rate_limit:${ip}`,
    `suspend:${ip}`,
    `fail_count:${ip}`
  ];

  try {
    // Iterate over each key and delete it from Redis
    for (const key of keysToDelete) {
      await redis.del(key);
    }
    logToFile(`All counters reset for IP: ${ip}`);
  } catch (error) {
    logToFile(`Error resetting counters for IP: ${ip}`, error);
  }
}
//-----------------------------------------------------------------------------------------------------------------------------

// Middleware to extract and attach client IP to the request object ###########################################################
function attachClientIp(req, res, next) {
  let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (ip.includes(',')) {
    ip = ip.split(',')[0]; // In case of multiple IPs, take the first one
  }
  req.clientIp = ip; // Attach the IP to the request object for global use
  next();
}

// Apply the middleware globally or to specific routes as needed
app.use(attachClientIp);

// // Initialize Redis client
// // const redis = require('redis');
// let redisClient = redis.createClient({ legacyMode: true });
// redisClient.connect().catch(console.error);

// const session = require('express-session');
// const RedisStore = require('connect-redis')(session);

// // Set up session middleware
// app.use(session({
//   store: new RedisStore({ client: redisClient }),
//   secret: 'DATTeam',
//   saveUninitialized: false,
//   resave: false,
// }));

//-----------------------------------------------------------------------------------------------------------------------------

// Function to check if inComingsessionId exists in Redis #####################################################################
async function checkSessionIdExists(sessionId) {
  const exists = await redis.get(sessionId);
  return exists !== null;
}

// Function to check if inComingsessionId exists in Redis #####################################################################

// Function Zone ############################################################################################################
//###########################################################################################################################


// Return 200 oK Zone  ######################################################################################################
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
// Return 200 oK Zone  ######################################################################################################

// Incoming Zone  ############################################################################################################
app.use((req, res, next) => {
  // logToFile(`Incoming Zone - Received a request to ${req.path} with body: ${JSON.stringify(req.body)}`);
  logToFile(`Incoming Zone - Received a request to ${req.path} with query: ${JSON.stringify(req.query)} and body: ${JSON.stringify(req.body)}`);
  next();
});
// Incoming Zone  ############################################################################################################

// Gen Session Zone  #########################################################################################################
app.get('/sessionID', async (req, res) => {

  logToFile(`Gen Session Zone - Starting to generate a session ID.`);

  // Function to generate a random letter (uppercase and lowercase)
  function getRandomLetter() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    return letters.charAt(Math.floor(Math.random() * letters.length));
  }
  // Function to generate a random number between 0 and 9
  function getRandomNumber() {
    return Math.floor(Math.random() * 10);
  }
  // Function to generate session ID
  function generateSessionId() {
    let sessionId = '';
    for (let i = 0; i < 6; i++) { // Generate 6 pairs of letter and number
      sessionId += getRandomLetter() + getRandomNumber();
    }
    return sessionId;
  }
  // Generating the session ID
  const inComingsessionId = generateSessionId();
  // Save inComingsessionId in Redis with a 120-second expiry
  await redis.set(inComingsessionId, "true", 'EX', 120);

  logToFile(`Gen Session Zone - Return to Angular. ${inComingsessionId}`);
  res.json(inComingsessionId);
});
// Gen Session Zone  #########################################################################################################

// Initial Zone  #############################################################################################################
app.post('/init', async (req, res) => {
  const token = await generateAndStoreToken(req.body.mobile);
  await logToFile(`Initial Zone - Generated token: ${token}`);
  res.json({ token });
});
// Initial Zone  #############################################################################################################

// Delete Mobile Zone  #######################################################################################################
app.delete('/delete/:mobile', (req, res) => {
  const mobile = req.params.mobile;
  logToFile(`Delete Mobile Zone - Received delete request for mobile: ${mobile}`);

  // Check if a token for the mobile number exists
  const existingToken = db.get('tokens').find({ mobile }).value();

  if (existingToken) {
    // If a token exists, remove it
    db.get('tokens').remove({ mobile }).write();
    logToFile(`Delete Mobile Zone - Token for mobile: ${mobile} deleted successfully`);
    res.json({ message: 'Delete Mobile Zone - Token deleted successfully' });
  } else {
    logToFile(`Delete Mobile Zone - Token for mobile: ${mobile} not found`);
    res.status(404).json({ message: 'Delete Mobile Zone - Token not found' });
  }
});
// Delete Mobile Zone  #######################################################################################################

// Authenicate Zone ##########################################################################################################
app.post('/auth', async (req, res) => {
  const { token, mobile } = req.body;

  if (!token || !mobile) {
    await logToFile('Autenicate Zone - No token or mobile number provided.');
    return res.status(400).json({ message: 'Autenicate Zone - No token or mobile number provided.' });
  }

  await logToFile(`Autenicate Zone - Received token: ${token} and mobile number: ${mobile}`);

  jwt.verify(token, secretKey, async (err, decoded) => {
    if (err) {
      await logToFile('Autenicate Zone - Failed to authenticate token.');
      return res.status(401).json({ message: 'Autenicate Zone - Failed to authenticate token.' });
    }

    // Retrieve the token data from the database
    const tokenData = db.get('tokens').find({ token }).value();

    if (tokenData) {
      // Check if the mobile number matches
      if (tokenData.mobile !== mobile) {
        await logToFile('Autenicate Zone - Mobile number does not match token.');
        return res.status(403).json({ message: 'Autenicate Zone - Mobile number does not match token.' });
      }

      //  If the password flag is false, return an error
      if (tokenData.password === false) {
        await logToFile('Autenicate Zone - The Password Flag is False.');
        return res.status(403).json({ message: 'Autenicate Zone - Password incorrect.' });
      }

      // Convert the timestamp to a date
      const expiryDate = new Date(tokenData.expiry);

      // Check if the token has expired
      if (Date.now() > expiryDate.getTime()) {
        await logToFile('Autenicate Zone - Token has expired.');
        return res.status(401).json({ message: 'Autenicate Zone - Token has expired.' });
      }



      // Format the date
      const formattedExpiryDate = format(expiryDate, 'yyyyMMdd HH:mm');
      await logToFile(`Autenicate Zone - Token is valid. The next expiry date is ${formattedExpiryDate}`);
      res.status(200).json({ message: 'Autenicate Zone - Token is valid.' });
    } else {
      await logToFile('Autenicate Zone - Token not found.');
      return res.status(403).json({ message: 'Autenicate Zone - Token not found.' });
    }
  });
});

// Authenicate Zone ##########################################################################################################

// Update Zone ###############################################################################################################
app.post('/updatePwd', async (req, res) => {
  const { token, mobile, password } = req.body;

  incomingPassword = password;

  if (!token || !mobile || !incomingPassword) {
    return res.status(400).json({ error: 'No input parameter.' });
  }

  // const incomingPassword = password;

  // Log the received token and mobile
  try {
    await logToFile(`Update Zone - Received token: ${token}`);
    await logToFile(`Update Zone - Received mobile: ${mobile}`);
    await logToFile(`Update Zone - Received incoming password: ${incomingPassword}`);
  } catch (error) {
    console.error('Error logging to file:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }

  logToFile(`Update Zone - Check Point 1, before search from Redis` );

  // // Query Redis for the password using the mobile number
  // const redisKey = `user:${mobile}:password`;
  // const storedPassword = await redisClient.get(redisKey);

  // Assuming smsMobile and inputPassword are already defined
  const redisKey = `auth:${mobile}`;

  // Retrieve the stored password from Redis
  const storedPassword = await redis.get(redisKey);

  // Check if the stored password matches the input password
  if (storedPassword === incomingPassword) {
    // console.log('Password is valid.');
    logToFile(`Update Zone - Password is valid. storedPassword: ${storedPassword} incomingPassword: ${incomingPassword}`);
  } else {
    console.log('Invalid password or mobile number.');
    logToFile(`Update Zone - Invalid password or mobile number. storedPassword: ${storedPassword} incomingPassword: ${incomingPassword}`);
    return res.status(401).json({ error: 'Invalid password or mobile number.' });
  }



  logToFile(`Update Zone - Check Point 2， after authenication from Redis` );



  // Proceed with your existing logic for token validation and response
  const tokenData = db.get('tokens').find({ token, mobile }).value();

  if (!tokenData) {
    await logToFile('Update Zone - No data found for the provided token and mobile');
    return res.status(400).json({ error: 'Invalid request - no data' });
  }

  const expiryDate = new Date(tokenData.expiry);
  if (expiryDate < new Date()) {
    await logToFile('Update Zone - Token has expired');
    return res.status(401).json({ error: 'Token has expired' });
  } else {
    db.get('tokens').find({ mobile, token }).assign({ password: true }).write();
    await logToFile('Update Zone - Password updated to true');
    return res.json({ success: true });
  }
});
// Update Zone ###############################################################################################################

// Redirect to Backend Server ################################################################################################
app.get('/reDirect/:mobile', async (req, res, next) => {
  const mobile = req.params.mobile;
  const token = req.query.token;


  // if ( mobile === '21000001' || mobile === '21000002' || mobile === '21000003'
  //         || mobile === '22000001' || mobile === '22000002' || mobile === '22000003'
  //         || mobile === '23000001' || mobile === '23000002' || mobile === '23000003'
  //         || mobile === '24000001' || mobile === '24000002' || mobile === '24000003'
  //         || mobile === '25000001' || mobile === '26000001' || mobile === '27000001'
  //         || mobile === '28000001' || mobile === '29000001' || mobile === '17000001'
  //         || mobile === '18000001' || mobile === '19000001' 
  //         || mobile === '89000001' || mobile === '89000002' || mobile === '89000003'
  //         || mobile === '86000001' || mobile === '86000002' || mobile === '86000003'
  //         || mobile === '87000001' || mobile === '88000001' || mobile === '88000002'
  //         || mobile === '99000001'     
        
  //       ) {
  //   logToFile(`In if mobile: ${mobile}`); // Log the value of inputMobile
  //     //const targetUrl = 'http://10.161.169.13:9800/eform-application/form_main?mobile=' + mobile;
  //     logToFile(`reDirect Zone - Handle for special mobile ${mobile}`);
  //     const targetUrl = 'https://eform.tvb.com.hk/eform-application/form_main?mobile=' + mobile;

  //     // Redirect to the URL
  //     // resetAllCountsByIP(req.clientIp);
  //      return res.redirect(targetUrl);

  //   }


  // Authenticate the token
  const tokenData = db.get('tokens').find({ token }).value();
  const tokenIsValid = tokenData && !isTokenExpired(token);

  await logToFile(`Token is valid: ${tokenIsValid}`);

  if (tokenIsValid) {
    // Define the target URL
    // const targetUrl = 'https://eform.tvb.com.hk:8228/eform-application/form_main?mobile=' + mobile;
    // const targetUrl = 'https://eform.tvb.com.hk:8228/eform-application/form_main?mobile=' + mobile;
    //const targetUrl = 'http://10.161.169.13:9800/eform-application/form_main?mobile=' + mobile;
    const targetUrl = 'https://eform.tvb.com.hk/eform-application/form_main?mobile=' + mobile;


    // Log the full URL
    logToFile('Redirecting to:', targetUrl);

    // Redirect to the URL
    resetAllCountsByIP(req.clientIp);
    res.redirect(targetUrl);

  } else {
    res.status(401).json({ message: 'Token is expired' });
  }
});

// Redirect to Backend Server ################################################################################################

// Check input email valid or not##############################################################################################
app.get('/checkEmail/:email', async (req, res) => {
  const email = req.params.email;

  if (!email) {
    await logToFile('No email provided.');
    return res.status(400).json({ message: 'No email provided.' });
  }

  try {
    const response = await axios.get(`${BASE_URL}/eform-application/ajax/checkInternalUser?email=${email}`);
    await logToFile(`Response from checkInternalUser API: ${JSON.stringify(response.data)}`);
    res.json(response.data);
  } catch (error) {
      await logToFile(`Check Email Zone - Error occurred: ${error}`);
      await logToFile(`Check Email Zone - Error occurred while checking email: ${error.message}`);
      res.status(500).json({ message: 'Error occurred while checking email.' });
    }
});

// Check input email valid or not##############################################################################################

// Check Mobile valid or not ##################################################################################################
app.get('/redForm-check/eform-application/ajax/checkMobile', async (req, res) => {

  const inputMobile = req.query.mobile;
  const sessionIdToCheck = req.query.sessionID;

  // if ( inputMobile === '21000001' || inputMobile === '21000002' || inputMobile === '21000003'
  //         || inputMobile === '22000001' || inputMobile === '22000002' || inputMobile === '22000003'
  //         || inputMobile === '23000001' || inputMobile === '23000002' || inputMobile === '23000003'
  //         || inputMobile === '24000001' || inputMobile === '24000002' || inputMobile === '24000003'
  //         || inputMobile === '25000001' || inputMobile === '26000001' || inputMobile === '27000001'
  //         || inputMobile === '28000001' || inputMobile === '29000001' || inputMobile === '17000001'
  //         || inputMobile === '18000001' || inputMobile === '19000001' 
  //         || inputMobile === '89000001' || inputMobile === '89000002' || inputMobile === '89000003'
  //         || inputMobile === '86000001' || inputMobile === '86000002' || inputMobile === '86000003'
  //         || inputMobile === '87000001' || inputMobile === '88000001' || inputMobile === '88000002'
  //         || inputMobile === '99000001'
        
  //       ) {

  //         logToFile(`Check Mobile Zone - inputMobile: ${inputMobile}`); // Log the value of inputMobile
  //         return res.status(200).json({ result: true, message1: "jump" , message2: "NULL", message3: "NULL"});
  // }

  logToFile(`Check Mobile Zone - Mobile: ${inputMobile}`); // Log the entire query object
  logToFile(`Check Mobile Zone - Session ID: ${sessionIdToCheck}`); // Log the value of inputMobile

  // Check if sessionIdToCheck has no value and return early
  if (!sessionIdToCheck) {
    logToFile('Check Mobile Zone - Session ID is empty');
    return res.status(500).json({ message: 'Session ID is empty' });
  }

  checkSessionIdExists(sessionIdToCheck).then(exists => {
    if (exists) {
      logToFile(`Check Mobile Zone - Session ID exists in Redis. ${sessionIdToCheck}`);
    } else {
      logToFile("Check Mobile Zone - Session ID does not exist or has expired.");
      return res.status(400).json({ message: 'Session ID does not exist or has expired.' });
    }
  });

  logToFile(`Check Mobile Zone - Client IP: ${req.clientIp}`);

  // await logToFile(`Before isRateLimited`);

  if (await isRateLimited(req.clientIp,'checkMobile')) {
    logToFile(`Check Mobile Zone - Sent exceeded message to Angular`);
    res.status(200).json({ result: false,
                            message1: "NULL",
                            message2: "exceed",
                            message3: "You have exceeded the maximum number of attempts. Please try again after 2 mins." });
    return; // Prevent further execution
  }

  // await logToFile(`After isRateLimited`);

  await logToFile(`Check Mobile Zone - Request query: ${JSON.stringify(req.query)}`); // Log the entire query object
  logToFile(`inputMobile: ${inputMobile}`); // Log the value of inputMobile


  if (!inputMobile) {
    await logToFile('No input mobile provided.');
    return res.status(400).json({ message: 'No input mobile provided.' });
  }

  try {
    await logToFile(`Sending request to ${BASE_URL}/eform-application/ajax/checkMobile with mobile=${inputMobile}`);
    const response = await axios.get(`${BASE_URL}/eform-application/ajax/checkMobile?mobile=${inputMobile}`);
    await logToFile(`Received response: ${JSON.stringify(response.data)}`);

    if (response.data === true) {
      logToFile('The response was true');
      return res.status(200).json({ result: true, message1: "stay" , message2: "NULL", message3: "NULL"});
    } else if (response.data === false) {
      logToFile('The response was false');
      return res.status(200).json({ result: false, message: "stay" , message2: "NULL", message3: "NULL"});
    }

  } catch (error) {
    await logToFile(`Check Mobile Zone - Error occurred: ${error}`);
    await logToFile(`Check Mobile Zone - Error occurred while checking mobile: ${error.message}`);
    return res.status(500).json({ message: 'Error occurred while checking mobile.' });

  }
});
// Check Mobile valid or not ##################################################################################################

// Send SMS ###################################################################################################################
app.get('/sent-sms/eform-application/ajax/sendSMS', async (req, res) => {
  const smsMobile = req.query.mobile;
  const smsFixMsg1 = String('&smsMessage=');
  const smsContent = String('The OTP password is ');
  const smsFixMsg2 = String('. Password is valid for 2 minutes. Please do not share this password with anyone. Thank you.');
  // const smsPwd = req.query.password;

  // Generate a password (for demonstration, using a simple method)
  const smsPwdA = Math.floor(1000 + Math.random() * 9000); // Generates a 4-digit random number
  const smsPwdB = Math.floor(1000 + Math.random() * 9000); // Generates a 4-digit random number

  // Trim password
  const smsPwd = String(smsPwdA) + String(smsPwdB);
  const smspwsSent = smsPwdA +" - " + smsPwdB;

  if (!smsMobile) {
    await logToFile('No sms mobile provided.');
    return res.status(400).json({ message: 'No sms mobile provided.' });
  }

  // Assuming smsMobile and smsPwd are already defined
  const redisKey = `auth:${smsMobile}`; // Prefixing with 'auth:' to namespace authentication keys
  const expirationTimeInSeconds = 120; // 2 minutes expiration

  // Set the smsPwd in Redis with smsMobile as the key
  await redis.set(redisKey, smsPwd, 'EX', expirationTimeInSeconds);

  logToFile(`Stored ${smsMobile} and password in Redis for authentication.`);

  // await logToFile(`Send SMS zone - Before isRateLimited`);

  if (await isRateLimited(req.clientIp,'SendSMS')) {
    logToFile(`SendSMS - Sent exceeded message to Angular`);
    res.status(400).json({ message: 'You have exceeded the maximum number of attempts. Please try again after 2 mins' });
    return;
  }

  logToFile(`SendSMS - Try to sent sms to ${smsMobile} with password ${smspwsSent}`);

  try {

    const url = `${BASE_URL}/eform-application/ajax/sendSMS?mobile=${smsMobile}` + smsFixMsg1 + smsContent + smspwsSent + smsFixMsg2;
    logToFile(`Request URL: ${url}`);
    const response = await axios.get(url);

    // const response = await axios.get(
    //   `${BASE_URL}/eform-application/ajax/sendSMS?mobile=${smsMobile}` +
    //   smsFixMsg + smsContent + smsPwd
    //   );
    await logToFile(`Response from sent sms API: ${JSON.stringify(response.data)}`);
    res.json(response.data);
  } catch (error) {
    await logToFile(`Sent SMS Zone - Error occurred: ${error}`);
    await logToFile(`Sent SMS Zone - Error occurred while sent sms: ${error.message}`);
    res.status(500).json({ message: 'Error occurred while sent sms.' });
  }
});

// Send SMS ###################################################################################################################

async function generateAndStoreToken(mobile, password) {
  // Generate a new token
  const newToken = jwt.sign({ mobile }, secretKey, { expiresIn: tokenExpiration });

  // Calculate the token expiry timestamp
  const tokenExpiryTimestamp = Date.now() + tokenExpiration;

  // Convert the timestamp to a date
  const expiryDate = new Date(tokenExpiryTimestamp);

  // Format the date
  const formattedExpiryDate = format(expiryDate, 'yyyy-MM-dd HH:mm');

  // Check if a token for the mobile number already exists
  const existingToken = db.get('tokens').find({ mobile }).value();

  if (existingToken) {
    // If a token exists, remove it
    db.get('tokens').remove({ mobile }).write();
  }

  // Calculate the current timestamp and format it
  const currentDate = new Date();
  const formattedCreateDate = format(currentDate, 'yyyy-MM-dd HH:mm');

  // Store the new token, mobile number, password, Create Date, and token expiry timestamp in the database
  db.get('tokens').push({ token: newToken, mobile, password: password ? Boolean(password) : false, CreateDate: formattedCreateDate, expiry: formattedExpiryDate })

    .write();

  await logToFile(`New token generated for mobile ${mobile} with expiry timestamp ${formattedExpiryDate}`);

  return newToken;
}

// Global error handling ###############################################################################################
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Application specific logging, throwing an error, or other logic here
});
// Global error handling ###############################################################################################

// Start the server and assign the result to the server variable
// let server = app.listen(listenPort, '0.0.0.0', () => logToFile(`Server running on IPv4 port ${listenPort}`));
app.listen(listenPort, () => logToFile(`Server running on port ${listenPort}`));

