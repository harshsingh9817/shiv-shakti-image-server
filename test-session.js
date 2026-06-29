const { StringSession } = require('telegram/sessions');
const MAIN_SESSION_STRING = "1BQANOTEuMTA4LjU2LjEyNwG7HWnadYBVrdX0IR8eEzIdGrMJWbScVrCpHsNkTlB1YcTkFRI6eYN+24Y0bOa1MhIkWea3+gbmP/O/DLPzgArDcvB9z8Cyo4xjeFh8bUIDwoUYHT8Wn6OORmHIWmMdytGplDqFK35pnfqP7vbJwl8ghZLeIVhx21zjWrbH4xzzTMLQasQf6i4YUQHpQ4WvQMYz2iVdG5LpMqtP2J4U25BmOh39xwbXlkO2IBVyChvaNMLOYh2va2dkO+2Fv6fid2WN3tnmtz7LQVgSE1s8sKUuVyMMKNAn7O1es+FGwl+WBeor5PSGoueeod+GSzWB1hSi2qtHhflAobjEZs/ILy6TVg==";

const stringSession = new StringSession(MAIN_SESSION_STRING);
console.log("Before override:");
console.log("dcId:", stringSession.dcId);
console.log("serverAddress:", stringSession.serverAddress);
console.log("port:", stringSession.port);

if (stringSession.dcId && stringSession.serverAddress) {
    stringSession.setDC(stringSession.dcId, stringSession.serverAddress, 443);
}

console.log("After override:");
console.log("dcId:", stringSession.dcId);
console.log("serverAddress:", stringSession.serverAddress);
console.log("port:", stringSession.port);
