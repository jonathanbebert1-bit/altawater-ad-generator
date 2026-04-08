/**
 * Job store with Redis persistence.
 * Falls back to in-memory Map if REDIS_URL is not set (local dev).
 * Each job tracks: status, steps, assets, errors, timestamps.
 */

import { createClient } from 'redis';

export const JOB_STATUS = {
  QUEUED: 'queued',
  GENERATING_VOICEOVER: 'generating_voiceover',
  GENERATING_VIDEO: 'generating_video',
  UPLOADING: 'uploading',
  COMPLETE: 'complete',
  FAILED: 'failed',
};

export const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
};

// ─── Redis client (lazy init) ──────────────────────────────────────────────

let redisClient = null;
let redisReady = false;
// Fallback in-memory store for local dev
const memStore = new Map();

const JOB_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

async function getRedis() {
  if (!process.env.REDIS_URL) return null;

  if (redisClient && redisReady) return redisClient;

  if (!redisClient) {
    console.log('[Redis] Connecting to Redis...');
    redisClient = createClient({ url: process.env.REDIS_URL });

    redisClient.on('error', err => {
      console.error('[Redis] Client error:', err.message);
      redisReady = false;
    });

    redisClient.on('ready', () => {
      console.log('[Redis] ✅ Connected');
      redisReady = true;
    });

    redisClient.on('end', () => {
      console.warn('[Redis] Connection closed');
      redisReady = false;
    });

    try {
      await redisClient.connect();
      redisReady = true;
    } catch (err) {
      console.error('[Redis] Failed to connect:', err.message);
      redisClient = null;
      return null;
    }
  }

  return redisReady ? redisClient : null;
}

// ─── Storage helpers ───────────────────────────────────────────────────────

async function saveJob(job) {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.setEx(`job:${job.jobId}`, JOB_TTL, JSON.stringify(job));
      // Track job IDs in a sorted set (score = timestamp)
      await redis.zAdd('jobs:index', { score: Date.now(), value: job.jobId });
    } catch (err) {
      console.error('[Redis] saveJob error:', err.message);
      // Fall through to memStore as backup
      memStore.set(job.jobId, job);
    }
  } else {
    memStore.set(job.jobId, job);
  }
}

async function loadJob(jobId) {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get(`job:${jobId}`);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.error('[Redis] loadJob error:', err.message);
    }
  }
  return memStore.get(jobId) || null;
}

async function loadAllJobs() {
  const redis = await getRedis();
  if (redis) {
    try {
      const ids = await redis.zRange('jobs:index', 0, -1, { REV: true });
      const jobs = [];
      for (const id of ids) {
        const raw = await redis.get(`job:${id}`);
        if (raw) {
          try { jobs.push(JSON.parse(raw)); } catch (_) {}
        }
      }
      return jobs;
    } catch (err) {
      console.error('[Redis] loadAllJobs error:', err.message);
    }
  }
  return Array.from(memStore.values());
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new job record and persist it.
 */
export async function createJob(jobId, script) {
  const job = {
    jobId,
    status: JOB_STATUS.QUEUED,
    script,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: {
      voiceover: { status: STEP_STATUS.PENDING, startedAt: null, completedAt: null, error: null },
      video: {
        status: STEP_STATUS.PENDING,
        scenes: [],
        startedAt: null,
        completedAt: null,
        error: null,
      },
      upload: { status: STEP_STATUS.PENDING, startedAt: null, completedAt: null, error: null },
    },
    assets: {
      voiceoverFile: null,
      voiceoverUrl: null,
      scenes: [],
      manifest: null,
      driveFolder: null,
    },
    error: null,
    completedAt: null,
  };
  await saveJob(job);
  return job;
}

export async function getJob(jobId) {
  return await loadJob(jobId);
}

export async function updateJob(jobId, updates) {
  const job = await loadJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  await saveJob(job);
  return job;
}

export async function updateStep(jobId, stepName, updates) {
  const job = await loadJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!job.steps[stepName]) job.steps[stepName] = {};
  Object.assign(job.steps[stepName], updates);
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
  return job;
}

/**
 * Returns a clean public-facing view of the job.
 */
export function jobSummary(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || null,
    steps: {
      voiceover: {
        status: job.steps?.voiceover?.status || STEP_STATUS.PENDING,
        completedAt: job.steps?.voiceover?.completedAt || null,
        error: job.steps?.voiceover?.error || null,
      },
      video: {
        status: job.steps?.video?.status || STEP_STATUS.PENDING,
        scenesCompleted: (job.steps?.video?.scenes || []).filter(s => s.status === STEP_STATUS.DONE).length,
        totalScenes: (job.steps?.video?.scenes || []).length,
        completedAt: job.steps?.video?.completedAt || null,
        error: job.steps?.video?.error || null,
      },
      upload: {
        status: job.steps?.upload?.status || STEP_STATUS.PENDING,
        completedAt: job.steps?.upload?.completedAt || null,
        error: job.steps?.upload?.error || null,
      },
    },
    assets: job.status === JOB_STATUS.COMPLETE ? {
      voiceoverUrl: job.assets?.voiceoverUrl || null,
      driveFolder: job.assets?.driveFolder || null,
      scenes: job.assets?.scenes || [],
      manifest: job.assets?.manifest || null,
    } : undefined,
    error: job.error || null,
  };
}

export async function listJobs() {
  const jobs = await loadAllJobs();
  return jobs.map(jobSummary);
}
