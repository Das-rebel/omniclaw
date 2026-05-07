const { VaultDB } = require('../deploy/core/vault_db');
(async () => {
  const db = new VaultDB();
  await db.connect();
  const node = await db.get('SELECT url, metadata, content FROM nodes WHERE type = ? LIMIT 1', ['twitter_tweet']);
  console. log(JSON.stringify(node, null, 2));
  process.exit();
})()