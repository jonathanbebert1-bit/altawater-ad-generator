/**
 * In-memory job store + status tracking.
 * For production scale, swap this with Redis + Bull queue.
 * Each job tracks: status, steps, assets, errors, timestamps.
 */

const jobs = new Map();

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

/**
 * Create a new job record and return it.
 */
export function createJob(jobId, script) {
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
      voiceoverFile: null,    // local path
      voiceoverUrl: null,     // Drive URL
      scenes: [],             // [{sceneIndex, prompt, localFile, driveUrl, driveFileId}]
      manifest: null,         // Drive URL of manifest JSON
      driveFolder: null,      // Drive folder URL for this ad
    },
    error: null,
    completedAt: null,
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  return job;
}

export function updateStep(jobId, stepName, updates) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  Object.assign(job.steps[stepName], updates);
  job.updatedAt = new Date().toISOString();
  return job;
}

/**
 * Returns a clean public-facing view of the job (no internal paths).
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
        status: job.steps.voiceover.status,
        completedAt: job.steps.voiceover.completedAt,
        error: job.steps.voiceover.error,
      },
      video: {
        status: job.steps.video.status,
        scenesCompleted: job.steps.video.scenes.filter(s => s.status === STEP_STATUS.DONE).length,
        totalScenes: job.steps.video.scenes.length,
        completedAt: job.steps.video.completedAt,
        error: job.steps.video.error,
      },
      upload: {
        status: job.steps.upload.status,
        completedAt: job.steps.upload.completedAt,
        error: job.steps.upload.error,
      },
    },
    error: job.error,
  };
}

export function listJobs() {
  return Array.from(jobs.values()).map(jobSummary);
}
