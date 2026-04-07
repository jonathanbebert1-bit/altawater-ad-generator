import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

function require_env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port: process.env.PORT || 3000,
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    // Default voice — "Rachel" is a clear, professional female voice
    // Override with ELEVENLABS_VOICE_ID in .env
    voiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
  },
  runway: {
    apiKey: process.env.RUNWAY_API_KEY || '',
    // gen4_turbo is the current Runway Gen-4 model identifier
    model: process.env.RUNWAY_MODEL || 'gen4_turbo',
    // 9:16 vertical for Meta/TikTok — 768x1280
    resolution: process.env.RUNWAY_RESOLUTION || '768:1280',
    duration: parseInt(process.env.RUNWAY_CLIP_DURATION || '5', 10), // seconds per clip
    scenesPerAd: parseInt(process.env.RUNWAY_SCENES_PER_AD || '4', 10),
  },
  google: {
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  },
  dashboard: {
    url: process.env.DASHBOARD_URL || 'https://altawater-dashboard-production.up.railway.app',
    secret: process.env.METRICS_SECRET || 'altawater-metrics-2026',
  },
  // Local temp dir for intermediate files
  tempDir: process.env.TEMP_DIR || '/tmp/altawater-ads',
};

export function validateConfig() {
  const missing = [];
  if (!config.elevenlabs.apiKey) missing.push('ELEVENLABS_API_KEY');
  if (!config.runway.apiKey) missing.push('RUNWAY_API_KEY');
  if (!config.google.serviceAccountJson) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!config.google.driveFolderId) missing.push('GOOGLE_DRIVE_FOLDER_ID');
  if (missing.length > 0) {
    console.warn(`⚠️  Missing env vars (service will start but generation will fail): ${missing.join(', ')}`);
  }
  return missing;
}
