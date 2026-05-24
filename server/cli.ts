import { ensureSchema } from './db.js';
import { startFullSync, getSyncStatus } from './sync.js';

ensureSchema();

const command = process.argv[2];

if (command === 'sync') {
  await startFullSync(30);
  const timer = setInterval(() => {
    const status = getSyncStatus();
    console.log(JSON.stringify(status));
    if (!status.running) {
      clearInterval(timer);
      process.exit(status.error ? 1 : 0);
    }
  }, 1000);
} else {
  console.log('Usage: npm run sync');
}
