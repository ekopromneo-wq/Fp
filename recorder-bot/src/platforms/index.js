import * as telemost from './telemost.js';

export const platforms = {
  telemost,
};

export function getPlatformAdapter(platform) {
  return platforms[platform] || null;
}
