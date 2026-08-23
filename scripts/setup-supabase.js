const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function setupSupabase() {
  const sqlPath = path.join(__dirname, '..', 'supabase-setup.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Attempting to apply Supabase schema...\n');

  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({ sql })
  });

  if (response.ok) {
    console.log('Schema applied successfully via exec_sql RPC.');
    process.exit(0);
  }

  const text = await response.text();
  console.log('Direct SQL execution failed (expected if exec_sql is not set up).');
  console.log('Response:', response.status, text.slice(0, 200));

  console.log('\nPlease run the following SQL in the Supabase SQL Editor:');
  console.log('(Dashboard -> Your Project -> SQL Editor -> New query)\n');
  console.log(sql);
  process.exit(1);
}

setupSupabase().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
