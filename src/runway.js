/**
 * Runway Gen-4.5 text-to-video generation.
 * Generates 4 scenes in parallel, each as a 5-second vertical clip (9:16 = 720:1280).
 * Uses the official @runwayml/sdk package v3+.
 */

import RunwayML, { TaskFailedError } from '@runwayml/sdk';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import https from 'https';
import http from 'http';
import { config } from './config.js';

let runwayClient = null;

function getClient() {
  if (!runwayClient) {
    runwayClient = new RunwayML({ apiKey: config.runway.apiKey });
  }
  return runwayClient;
}

/**
 * Build scene prompts from script data.
 * The script contains hook, market, offer, and voiceover — we derive
 * visually distinct prompts for each scene.
 */
export function buildScenePrompts(script) {
  const { hook, market, offer, voiceover, brand = 'Alta Water' } = script;
  const baseStyle =
    'cinematic vertical 9:16 format, broadcast quality, vibrant colors, ' +
    'professional advertising, clean healthy lifestyle, photorealistic';

  return [
    // Scene 1: Hook — attention-grabbing opener
    {
      index: 0,
      label: 'hook',
      prompt:
        `${hook || 'Person looking concerned at tap water in modern kitchen'}. ` +
        `${baseStyle}. Opening scene, close-up shot, dramatic lighting, pulls viewer in immediately.`,
    },
    // Scene 2: Problem — market pain point
    {
      index: 1,
      label: 'problem',
      prompt:
        `${market || 'Family worried about water quality at home, looking at murky tap water'}. ` +
        `${baseStyle}. Problem scene, medium shot, slightly desaturated to emphasize concern.`,
    },
    // Scene 3: Solution — product hero
    {
      index: 2,
      label: 'solution',
      prompt:
        `${brand} water filtration system, crystal clear clean water flowing from modern faucet, ` +
        `satisfied homeowner smiling. ${baseStyle}. Product hero shot, bright and clean aesthetic, ` +
        `water droplets glistening.`,
    },
    // Scene 4: CTA — aspirational close
    {
      index: 3,
      label: 'cta',
      prompt:
        `${offer || 'Happy family enjoying clean pure water together, modern bright kitchen'}. ` +
        `${baseStyle}. Closing CTA scene, warm inviting tones, aspirational lifestyle, joyful energy.`,
    },
  ];
}

/**
 * Generate a single video scene using Runway Gen-4.5 text-to-video.
 * Returns { taskId, videoUrl }.
 */
async function generateScene(scenePrompt, jobId) {
  const client = getClient();
  const { index, label, prompt } = scenePrompt;

  console.log(`[Runway] Submitting scene ${index} (${label}) for job ${jobId}`);
  console.log(`[Runway] Prompt: ${prompt.substring(0, 120)}...`);

  // Use waitForTaskOutput() — SDK polls automatically
  const task = await client.textToVideo
    .create({
      model: 'gen4_turbo',
      promptText: prompt,
      ratio: '720:1280',   // 9:16 vertical for Meta/TikTok
      duration: config.runway.duration,
    })
    .waitForTaskOutput({ pollingOptions: { intervalMs: 5000 } });

  const videoUrl = task.output?.[0];
  if (!videoUrl) throw new Error(`Runway task ${task.id} succeeded but returned no output URL`);

  console.log(`[Runway] ✅ Scene ${index} complete: ${videoUrl}`);
  return { taskId: task.id, videoUrl };
}

/**
 * Download a video from a URL to a local file.
 * Follows redirects.
 */
async function downloadVideo(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(outputPath);
    const protocol = url.startsWith('https') ? https : http;

    const handleResponse = (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        downloadVideo(response.headers.location, outputPath).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
      response.on('error', reject);
    };

    protocol.get(url, handleResponse).on('error', err => {
      file.close();
      reject(err);
    });
  });
}

/**
 * Generate all 4 scenes in parallel.
 *
 * @param {string} jobId
 * @param {object} script - { hook, market, offer, voiceover, brand }
 * @param {string} tempDir - local directory for temp files
 * @param {function} [onSceneProgress] - optional progress callback
 * @returns {Promise<Array>} Array of { index, label, prompt, localFile, videoUrl, taskId, error }
 */
export async function generateVideoScenes(jobId, script, tempDir, onSceneProgress) {
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const scenePrompts = buildScenePrompts(script);
  console.log(`[Runway] Generating ${scenePrompts.length} scenes in parallel for job ${jobId}`);

  const sceneResults = await Promise.allSettled(
    scenePrompts.map(async scenePrompt => {
      const { index, label } = scenePrompt;

      try {
        if (onSceneProgress) onSceneProgress({ index, label, status: 'RUNNING' });

        const { taskId, videoUrl } = await generateScene(scenePrompt, jobId);

        // Download to local temp dir
        const localFile = join(tempDir, `${jobId}-scene-${index}-${label}.mp4`);
        console.log(`[Runway] Downloading scene ${index} to ${localFile}`);
        await downloadVideo(videoUrl, localFile);
        console.log(`[Runway] ✅ Scene ${index} downloaded`);

        if (onSceneProgress) onSceneProgress({ index, label, status: 'SUCCEEDED', taskId });

        return { index, label, prompt: scenePrompt.prompt, localFile, videoUrl, taskId, error: null };
      } catch (err) {
        const errMsg = err instanceof TaskFailedError
          ? `Task failed: ${err.taskDetails?.failure || err.message}`
          : err.message;

        console.error(`[Runway] ❌ Scene ${index} failed: ${errMsg}`);
        if (onSceneProgress) onSceneProgress({ index, label, status: 'FAILED', error: errMsg });

        return {
          index,
          label,
          prompt: scenePrompt.prompt,
          localFile: null,
          videoUrl: null,
          taskId: null,
          error: errMsg,
        };
      }
    })
  );

  return sceneResults.map(r =>
    r.status === 'fulfilled'
      ? r.value
      : { index: -1, label: 'unknown', error: r.reason?.message, localFile: null, videoUrl: null, taskId: null }
  );
}
