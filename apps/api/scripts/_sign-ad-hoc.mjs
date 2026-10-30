import { sign } from 'truelayer-signing';
import { readFileSync } from 'node:fs';
const [kid, paymentId, bodyPath, pemPath] = process.argv.slice(2);
const sig = sign({
  kid, privateKeyPem: readFileSync(pemPath, 'utf8'),
  method: 'POST', path: '/v3/payments',
  headers: { 'Idempotency-Key': paymentId },
  body: readFileSync(bodyPath, 'utf8'),
});
console.log(sig);
