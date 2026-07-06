import * as telemost from './telemost.js';
import * as zoom from './zoom.js';

export const platforms = {
  telemost,
  zoom,
};

export function getPlatformAdapter(platform) {
  return platforms[platform] || null;
}
