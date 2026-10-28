import { readFileSync } from 'node:fs';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (typeof metadata.version !== 'string' || !metadata.version) throw new Error('The plugin package version is invalid.');

export const productVersion = metadata.version;
