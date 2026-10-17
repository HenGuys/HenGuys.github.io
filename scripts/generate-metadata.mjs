import { writeMetadata } from './metadata-core.mjs';
const amount = Number(process.env.METADATA_LOOKUPS_PER_RUN ?? 100);
if (!Number.isSafeInteger(amount) || amount < 0 || amount > 3000) throw new Error('METADATA_LOOKUPS_PER_RUN must be between 0 and 3000');
await writeMetadata({
  dist: process.env.DIST_DIR || 'dist',
  cache: process.env.METADATA_CACHE || 'cache/metadata-v1.json',
  repository: process.env.GITHUB_REPOSITORY || 'HenGuys/HenGuys.github.io',
  maxLookups: amount,
});
