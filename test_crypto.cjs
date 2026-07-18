const { seal } = require('tweetsodium');
const repoPublicKey = "8d18476d05f3131c9d816a7f9b88e146e4dfdf085de50eb6a0a09e0750567e78"; // Random key just for testing btoa
const repoKeyBytes = Uint8Array.from(Buffer.from(repoPublicKey, 'hex'));
const secretBytes = new TextEncoder().encode("mysecret");
const encrypted = seal(secretBytes, repoKeyBytes);
const b64 = Buffer.from(encrypted).toString('base64');
console.log(b64);
