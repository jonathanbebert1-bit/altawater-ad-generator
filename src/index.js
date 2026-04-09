/**
 * Alta Water Ad Generator — Express API
 *
 * POST /generate-ad    → start generation job, returns jobId
 * GET  /status/:jobId  → poll job progress
 * GET  /assets/:jobId  → get all generated assets + Drive links
 * POST /publish        → (future) post to dashboard/Meta
 * GET  /jobs           → list all jobs (debug)
 * GET  /health         → health check
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

import { config, validateConfig } from './config.js';
import { generateVoiceover } from './elevenlabs.js';
import { generateVideoFromScript, checkVideoStatus } from './banana.js';
import { uploadAdAssets } from './drive.js';
import {
  createJob,
  getJob,
  updateJob,
  updateStep,
  jobSummary,
  listJobs,
  JOB_STATUS,
  STEP_STATUS,
} from './job.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'altawater-ad-generator',
    version: '2.0.0',
    redis: !!process.env.REDIS_URL,
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /generate-ad ──────────────────────────────────────────────────────

/**
 * Expected body:
 * {
 *   hook: "Stop throwing away money on bottled water",
 *   market: "Homeowners in Utah worried about water quality",
 *   offer: "Free installation + first month free",
 *   voiceover: "Full voiceover script text...",
 *   brand: "Alta Water"  // optional, defaults to "Alta Water"
 * }
 */
app.post('/generate-ad', async (req, res) => {
  const { hook, market, offer, voiceover, brand } = req.body;

  if (!voiceover && !hook) {
    return res.status(400).json({
      error: 'Missing required fields: voiceover (or hook) must be provided',
    });
  }

  const scriptText = voiceover || `${hook}. ${offer}`;
  const jobId = uuidv4();

  const script = { hook, market, offer, voiceover: scriptText, brand: brand || 'Alta Water' };

  try {
    await createJob(jobId, script);
    console.log(`[Job] Created job ${jobId}`);
  } catch (err) {
    console.error(`[Job] Failed to create job: ${err.message}`);
    return res.status(500).json({ error: 'Failed to create job', detail: err.message });
  }

  // Kick off generation in background
  runGenerationPipeline(jobId, script).catch(err => {
    console.error(`[Job] ❌ Pipeline error for ${jobId}:`, err);
    updateJob(jobId, { status: JOB_STATUS.FAILED, error: err.message }).catch(() => {});
  });

  res.status(202).json({
    jobId,
    status: JOB_STATUS.QUEUED,
    message: 'Ad generation started. Poll /status/:jobId for progress.',
    estimatedMinutes: '5-10',
    links: {
      status: `/status/${jobId}`,
      assets: `/assets/${jobId}`,
    },
  });
});

// ─── GET /status/:jobId ──────────────────────────────────────────────────────

app.get('/status/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(jobSummary(job));
  } catch (err) {
    console.error('[Status] Error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve job status', detail: err.message });
  }
});

// ─── GET /assets/:jobId ──────────────────────────────────────────────────────

app.get('/assets/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status !== JOB_STATUS.COMPLETE) {
      return res.json({
        jobId: job.jobId,
        status: job.status,
        message: 'Generation still in progress',
        assets: null,
      });
    }

    res.json({
      jobId: job.jobId,
      status: job.status,
      completedAt: job.completedAt,
      assets: job.assets,
      script: job.script,
    });
  } catch (err) {
    console.error('[Assets] Error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve assets', detail: err.message });
  }
});

// ─── POST /publish ───────────────────────────────────────────────────────────

app.post('/publish', async (req, res) => {
  const { jobId, target } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const job = await getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== JOB_STATUS.COMPLETE) {
    return res.status(409).json({ error: 'Job not complete yet', status: job.status });
  }

  // TODO: Wire into dashboard API and Meta Ads API
  res.json({
    jobId,
    message: 'Publish endpoint ready — dashboard/Meta integration coming soon',
    target: target || 'dashboard',
    assets: job.assets,
    dashboardUrl: config.dashboard.url,
  });
});

// ─── GET /jobs (debug) ───────────────────────────────────────────────────────

app.get('/jobs', async (req, res) => {
  try {
    const jobs = await listJobs();
    res.json({ jobs, count: jobs.length });
  } catch (err) {
    console.error('[Jobs] Error:', err.message);
    res.status(500).json({ error: 'Failed to list jobs', detail: err.message });
  }
});

// ─── Core Generation Pipeline ────────────────────────────────────────────────

async function runGenerationPipeline(jobId, script) {
  const tempDir = join(config.tempDir, jobId);
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  console.log(`[Pipeline] Starting job ${jobId}`);

  let voiceoverPath = null;
  let scenes = [];

  try {
    // ── Step 1: ElevenLabs voiceover ──────────────────────────────────────
    console.log(`[Pipeline] Step 1: Generating voiceover for job ${jobId}`);
    await updateJob(jobId, { status: JOB_STATUS.GENERATING_VOICEOVER });
    await updateStep(jobId, 'voiceover', { status: STEP_STATUS.RUNNING, startedAt: new Date().toISOString() });

    try {
      voiceoverPath = await generateVoiceover(jobId, script.voiceover, tempDir);
      await updateStep(jobId, 'voiceover', {
        status: STEP_STATUS.DONE,
        completedAt: new Date().toISOString(),
      });
      console.log(`[Pipeline] ✅ Voiceover done: ${voiceoverPath}`);
    } catch (err) {
      console.error(`[Pipeline] ❌ Voiceover failed:`, err.message, err.stack);
      await updateStep(jobId, 'voiceover', {
        status: STEP_STATUS.FAILED,
        error: err.message,
        completedAt: new Date().toISOString(),
      });
      throw new Error(`Voiceover generation failed: ${err.message}`);
    }

    // ── Step 2: Runway video generation (parallel) ────────────────────────
    console.log(`[Pipeline] Step 2: Generating video scenes for job ${jobId}`);
    await updateJob(jobId, { status: JOB_STATUS.GENERATING_VIDEO });
    await updateStep(jobId, 'video', {
      status: STEP_STATUS.RUNNING,
      startedAt: new Date().toISOString(),
      scenes: [0, 1, 2, 3].map(i => ({ index: i, status: STEP_STATUS.PENDING })),
    });

    try {
      scenes = await generateVideoScenes(jobId, script, tempDir, async progress => {
        // Update individual scene status
        try {
          const job = await getJob(jobId);
          if (job?.steps?.video?.scenes) {
            const sceneEntry = job.steps.video.scenes.find(s => s.index === progress.index);
            if (sceneEntry) {
              sceneEntry.status = progress.status === 'SUCCEEDED' ? STEP_STATUS.DONE
                : progress.status === 'FAILED' ? STEP_STATUS.FAILED
                : STEP_STATUS.RUNNING;
              sceneEntry.taskId = progress.taskId;
              sceneEntry.runwayStatus = progress.status;
            }
            await updateStep(jobId, 'video', { scenes: job.steps.video.scenes });
          }
        } catch (e) {
          console.warn(`[Pipeline] Scene progress update failed: ${e.message}`);
        }
      });
    } catch (err) {
      console.error(`[Pipeline] ❌ Video generation failed:`, err.message, err.stack);
      await updateStep(jobId, 'video', {
        status: STEP_STATUS.FAILED,
        error: err.message,
        completedAt: new Date().toISOString(),
      });
      throw new Error(`Video generation failed: ${err.message}`);
    }

    const failedScenes = scenes.filter(s => s.error);
    if (failedScenes.length === scenes.length) {
      throw new Error(`All video scenes failed: ${failedScenes.map(s => s.error).join('; ')}`);
    }

    await updateStep(jobId, 'video', {
      status: STEP_STATUS.DONE,
      completedAt: new Date().toISOString(),
      scenes: scenes.map(s => ({
        index: s.index,
        label: s.label,
        status: s.error ? STEP_STATUS.FAILED : STEP_STATUS.DONE,
        error: s.error || null,
      })),
    });

    if (failedScenes.length > 0) {
      console.warn(`[Pipeline] ⚠️  ${failedScenes.length}/${scenes.length} scenes failed, continuing with partial upload`);
    }

    // ── Step 3: Google Drive upload ───────────────────────────────────────
    console.log(`[Pipeline] Step 3: Uploading to Google Drive for job ${jobId}`);
    await updateJob(jobId, { status: JOB_STATUS.UPLOADING });
    await updateStep(jobId, 'upload', { status: STEP_STATUS.RUNNING, startedAt: new Date().toISOString() });

    let driveManifest;
    try {
      driveManifest = await uploadAdAssets(jobId, script, voiceoverPath, scenes);
      await updateStep(jobId, 'upload', {
        status: STEP_STATUS.DONE,
        completedAt: new Date().toISOString(),
      });
      console.log(`[Pipeline] ✅ Drive upload done`);
    } catch (err) {
      console.error(`[Pipeline] ❌ Drive upload failed:`, err.message, err.stack);
      await updateStep(jobId, 'upload', {
        status: STEP_STATUS.FAILED,
        error: err.message,
        completedAt: new Date().toISOString(),
      });
      throw new Error(`Drive upload failed: ${err.message}`);
    }

    // ── Done ──────────────────────────────────────────────────────────────
    await updateJob(jobId, {
      status: JOB_STATUS.COMPLETE,
      completedAt: new Date().toISOString(),
      assets: {
        voiceoverUrl: driveManifest.voiceover?.driveUrl || null,
        voiceoverFileId: driveManifest.voiceover?.driveFileId || null,
        scenes: driveManifest.scenes || [],
        manifest: driveManifest.manifestUrl || null,
        driveFolder: driveManifest.driveFolder || null,
        driveFolderId: driveManifest.driveFolderId || null,
      },
    });

    console.log(`[Job] ✅ Job ${jobId} complete! Folder: ${driveManifest.driveFolder}`);

    // Clean up temp files
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[Job] Could not clean up temp dir: ${cleanupErr.message}`);
    }
  } catch (err) {
    console.error(`[Job] ❌ Job ${jobId} failed: ${err.message}`);
    console.error(err.stack);
    try {
      await updateJob(jobId, {
        status: JOB_STATUS.FAILED,
        error: err.message,
      });
    } catch (updateErr) {
      console.error(`[Job] Could not update failed status: ${updateErr.message}`);
    }
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = config.port;

app.listen(PORT, () => {
  console.log(`\n🚰 Alta Water Ad Generator v2 running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Generate: POST http://localhost:${PORT}/generate-ad`);
  console.log(`   Redis: ${process.env.REDIS_URL ? '✅ configured' : '⚠️  not configured (in-memory fallback)'}\n`);
  validateConfig();
});

export default app;
