/**
 * ElevenLabs voiceover generation.
 * Uses the official @elevenlabs/elevenlabs-js SDK to convert the ad script
 * to broadcast-quality audio (MP3 44.1kHz 128kbps).
 */

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { config } from './config.js';

let client = null;

function getClient() {
  if (!client) {
    client = new ElevenLabsClient({ apiKey: config.elevenlabs.apiKey });
  }
  return client;
}

/**
 * Generate voiceover audio from script text.
 * @param {string} jobId - Used for file naming
 * @param {string} scriptText - Full voiceover script
 * @param {string} tempDir - Directory to save audio file
 * @returns {Promise<string>} Path to saved MP3 file
 */
export async function generateVoiceover(jobId, scriptText, tempDir) {
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const outputPath = join(tempDir, `${jobId}-voiceover.mp3`);
  const el = getClient();

  console.log(`[ElevenLabs] Generating voiceover for job ${jobId} (${scriptText.length} chars)`);
  console.log(`[ElevenLabs] Voice ID: ${config.elevenlabs.voiceId}, Model: ${config.elevenlabs.modelId}`);

  // SDK returns a ReadableStream<Uint8Array>
  const audioStream = await el.textToSpeech.convert(config.elevenlabs.voiceId, {
    text: scriptText,
    modelId: config.elevenlabs.modelId,
    outputFormat: 'mp3_44100_128',
    voiceSettings: {
      stability: 0.5,
      similarityBoost: 0.8,
      style: 0.2,
      useSpeakerBoost: true,
    },
  });

  // Pipe the web ReadableStream to a file write stream
  const nodeStream = Readable.fromWeb
    ? Readable.fromWeb(audioStream)          // Node 18+ native
    : Readable.from(audioStream);            // fallback

  const writeStream = createWriteStream(outputPath);
  await pipeline(nodeStream, writeStream);

  console.log(`[ElevenLabs] ✅ Voiceover saved to ${outputPath}`);
  return outputPath;
}

/**
 * List available voices for reference.
 */
export async function listVoices() {
  const el = getClient();
  const res = await el.voices.getAll();
  return (res.voices || []).map(v => ({
    voiceId: v.voiceId,
    name: v.name,
    category: v.category,
    labels: v.labels,
  }));
}
