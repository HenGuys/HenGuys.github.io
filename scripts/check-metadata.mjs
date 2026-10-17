import { validateStaticAddon } from './metadata-core.mjs';
const result = await validateStaticAddon(process.env.DIST_DIR || 'dist');
console.log('Validated:', result);
