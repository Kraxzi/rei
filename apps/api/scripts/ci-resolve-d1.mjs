// CI helper: find (or create) the D1 database "rei" in the Cloudflare account and write its id into wrangler.jsonc.
// Uses CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the environment via wrangler.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = 'rei';
const wr = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

let list = JSON.parse(wr('d1', 'list', '--json'));
let db = list.find((d) => d.name === NAME);
if (!db) {
  console.log(`D1 "${NAME}" not found — creating`);
  wr('d1', 'create', NAME);
  list = JSON.parse(wr('d1', 'list', '--json'));
  db = list.find((d) => d.name === NAME);
}
if (!db?.uuid) throw new Error('could not resolve D1 database id');

const path = new URL('../wrangler.jsonc', import.meta.url);
const cfg = readFileSync(path, 'utf8').replace(/"database_id":\s*"[^"]*"/, `"database_id": "${db.uuid}"`);
writeFileSync(path, cfg);
console.log(`D1 "${NAME}" = ${db.uuid}`);
