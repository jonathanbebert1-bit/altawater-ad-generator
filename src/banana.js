/**
 * Banana GPU API Integration
 * Replaces Runway for video generation
 * https://www.banana.dev/
 */

import axios from 'axios';

const BANANA_API_KEY = process.env.BANANA_API_KEY;
const BANANA_MODEL_KEY = process.env.BANANA_MODEL_KEY || 'text-to-video'; // or your custom model

if (!BANANA_API_KEY) {
  console.warn('⚠️  BANANA_API_KEY not set — video generation will fail');
}

/**
 * Generate video from script using Banana GPU
 * Much cheaper than Runway (~$0.10-0.20 vs $1.00)
 */
export async function generateVideoFromScript(scriptText, options = {}) {
  if (!BANANA_API_KEY) {
    throw new Error('BANANA_API_KEY not configured');
  }

  const {
    duration = 30, // seconds
    style = 'cinematic', // cinematic, ugc, product_demo
    aspectRatio = '16:9',
    fps = 24,
  } = options;

  try {
    console.log(`🍌 Banana: Generating ${duration}s video from script...`);

    const response = await axios.post(
      'https://api.banana.dev/v1/run',
      {
        model_key: BANANA_MODEL_KEY,
        // Adjust payload based on Banana's actual API
        input: {
          script: scriptText,
          duration,
          style,
          aspect_ratio: aspectRatio,
          fps,
          quality: 'hd', // hd, 4k
        },
      },
      {
        headers: {
          Authorization: `Bearer ${BANANA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 300000, // 5 min
      }
    );

    if (response.data.error) {
      throw new Error(`Banana API error: ${response.data.error}`);
    }

    const { request_id, output } = response.data;

    console.log(`✅ Banana video generation started (request_id: ${request_id})`);

    return {
      videoId: request_id,
      status: 'processing',
      videoUrl: output?.video_url || null,
      requestId: request_id,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Banana generation failed:', error.message);
    throw error;
  }
}

/**
 * Poll Banana job status
 */
export async function checkVideoStatus(requestId) {
  if (!BANANA_API_KEY) {
    throw new Error('BANANA_API_KEY not configured');
  }

  try {
    const response = await axios.get(
      `https://api.banana.dev/v1/status/${requestId}`,
      {
        headers: {
          Authorization: `Bearer ${BANANA_API_KEY}`,
        },
      }
    );

    const { status, output, error } = response.data;

    if (error) {
      return { status: 'failed', error };
    }

    if (status === 'succeeded') {
      return {
        status: 'completed',
        videoUrl: output?.video_url,
        metadata: output?.metadata || {},
      };
    }

    return {
      status: status === 'processing' ? 'processing' : 'queued',
      progress: output?.progress || 0,
    };
  } catch (error) {
    console.error('❌ Banana status check failed:', error.message);
    throw error;
  }
}

/**
 * Generate multiple scenes for a single ad
 * Banana can parallelize these
 */
export async function generateMultipleScenes(scenes) {
  // scenes = [{ text: "...", duration: 10 }, { text: "...", duration: 10 }]
  const jobs = scenes.map((scene) => generateVideoFromScript(scene.text, { duration: scene.duration }));

  const results = await Promise.all(jobs);
  return results;
}

export default {
  generateVideoFromScript,
  checkVideoStatus,
  generateMultipleScenes,
};
