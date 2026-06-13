const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input"); // Requires npm install input

// Replace these with your actual values if different
const apiId = 32680911; 
const apiHash = "448b0b278e63af1c52f92b7696e874cf"; 
const stringSession = new StringSession(""); 

(async () => {
  console.log("Loading interactive example...");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  
  await client.start({
    phoneNumber: async () => await input.text("Please enter your number (with country code, e.g. +91...): "),
    password: async () => await input.text("Please enter your 2FA password (if you have one): "),
    phoneCode: async () => await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });
  
  console.log("\n✅ You should now be connected.");
  const generatedString = client.session.save();
  console.log("\n=======================================================");
  console.log("🚨 HERE IS YOUR NEW SESSION STRING 🚨");
  console.log("=======================================================\n");
  console.log(generatedString);
  console.log("\n=======================================================");
  console.log("Copy the long string above and replace MAIN_SESSION_STRING in server.js!");
  
  await client.disconnect();
})();
