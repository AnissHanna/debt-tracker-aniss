// Generates pwa/config.js from environment variables at deploy time.
// Netlify: Build command `node scripts/write-config.mjs`, Publish directory `pwa`.
// Required env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY. Refuses to write a secret / service-role key.
import { writeFileSync } from 'node:fs';

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) throw new Error('SUPABASE_URL is missing or invalid');
if (!key.startsWith('sb_publishable_')) throw new Error('SUPABASE_PUBLISHABLE_KEY must be a publishable key (sb_publishable_…). Never use a secret or service-role key.');

const out = `window.MDT_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabasePublishableKey: key }, null, 2)};\n`;
writeFileSync(new URL('../pwa/config.js', import.meta.url), out);
console.log('pwa/config.js written for', url);
