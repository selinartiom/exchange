require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');

async function main() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  await pool.end();
  console.log('schema ok');
}

main().catch(async (err) => {
  console.error(err.message);
  try {
    await pool.end();
  } catch (_) {
    // ignore shutdown errors
  }
  process.exit(1);
});
