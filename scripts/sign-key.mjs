#!/usr/bin/env node
// Mint a NARIKJSON license key. Implements the documented key format
// (LICENSING_ARCHITECTURE_PROMPT.md §1.5): 15 bytes -> 24 Crockford base32
// chars, grouped XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.
//
//   header (7 bytes): [0] version=1
//                     [1] tier index into TIERS
//                     [2..3] expiry days-since-epoch, uint16 BE (0 = never)
//                     [4..6] first 3 bytes of sha256(lowercased email)
//   signature (8 bytes): first 8 bytes of HMAC-SHA256(header, secret)
//
// Usage:
//   LICENSE_SIGNING_SECRET=... node scripts/sign-key.mjs <email> [tier] [days]
//     days: 0 = lifetime (never expires) · 365 = one year · 7 = 7-day test key
//     tier: Essential | Premium | Unbxd   (index-stable, append-only)
//
// IMPORTANT: this must use the SAME LICENSE_SIGNING_SECRET as your /verify
// endpoint. After minting one key, test-activate it in the app to confirm it
// validates; if it doesn't, your server's keys.mjs layout differs — use that.

import crypto from 'node:crypto';

const TIERS = ['Essential', 'Premium', 'Unbxd']; // append-only; NARIK uses "Unbxd"
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const [, , email, tierArg = 'Unbxd', daysArg = '0'] = process.argv;
const secret = process.env.LICENSE_SIGNING_SECRET;

if (!email || !secret) {
  console.error('Usage: LICENSE_SIGNING_SECRET=... node scripts/sign-key.mjs <email> [tier] [days]');
  console.error('  days: 0 = lifetime, N = expires N days from today');
  console.error('  tier: ' + TIERS.join(' | '));
  process.exit(1);
}

const tierIndex = TIERS.indexOf(tierArg);
if (tierIndex < 0) {
  console.error('tier must be one of: ' + TIERS.join(', '));
  process.exit(1);
}
const days = parseInt(daysArg, 10) || 0;

const header = Buffer.alloc(7);
header[0] = 1; // version
header[1] = tierIndex;
const expiryDays = days > 0 ? Math.floor(Date.now() / 86400000) + days : 0; // 0 = never
header.writeUInt16BE(expiryDays & 0xffff, 2);
crypto.createHash('sha256').update(email.trim().toLowerCase()).digest().copy(header, 4, 0, 3);

const sig = crypto.createHmac('sha256', secret).update(header).digest().subarray(0, 8);
const raw = Buffer.concat([header, sig]); // 15 bytes = 120 bits = exactly 24 base32 chars

let bits = 0, val = 0, out = '';
for (const b of raw) {
  val = (val << 8) | b;
  bits += 8;
  while (bits >= 5) { out += CROCKFORD[(val >>> (bits - 5)) & 31]; bits -= 5; }
}
if (bits > 0) out += CROCKFORD[(val << (5 - bits)) & 31];

const key = out.match(/.{1,4}/g).join('-');
const validity = days > 0 ? `expires ${new Date(expiryDays * 86400000).toISOString().slice(0, 10)} (${days} days)` : 'lifetime';
console.error(`email: ${email}  tier: ${tierArg}  ${validity}`);
console.log(key);
