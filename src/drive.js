/**
 * Google Drive upload utilities.
 * Uses a service account (Domain-Wide Delegation) to upload assets
 * into an organized folder structure under the configured parent folder.
 *
 * Folder structure per ad:
 *   GOOGLE_DRIVE_FOLDER_ID/
 *     {jobId} - {YYYY-MM-DD}/
 *       voiceover.mp3
 *       scene-0-hook.mp4
 *       scene-1-problem.mp4
 *       scene-2-solution.mp4
 *       scene-3-cta.mp4
 *       manifest.json
 */

import { google } from 'googleapis';
import { createReadStream, statSync, existsSync } from 'fs';
import { basename } from 'path';
import { config } from './config.js';

let driveClient = null;

function getDriveClient() {
  if (driveClient) return driveClient;

  const rawJson = config.google.serviceAccountJson;
  if (!rawJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');

  let credentials;
  try {
    credentials = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  } catch (e) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e.message}`);
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  }

  console.log(`[Drive] Using service account: ${credentials.client_email}`);

  // Use Domain-Wide Delegation to impersonate the Drive owner.
  // Service accounts have no storage quota of their own; DWD lets us
  // write into the user's Drive on their behalf.
  const impersonateUser = process.env.GOOGLE_IMPERSONATE_USER || 'jono@drinkaltawater.com';
  console.log(`[Drive] Impersonating ${impersonateUser} via DWD`);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
    clientOptions: { subject: impersonateUser },
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Retry wrapper for Drive API calls.
 */
async function withRetry(fn, label, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRetryable = err.code === 429 || err.code === 500 || err.code === 503
        || err.message?.includes('ECONNRESET') || err.message?.includes('socket hang up');
      console.error(`[Drive] ${label} attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts && isRetryable) {
        const delay = attempt * 2000;
        console.log(`[Drive] Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else if (attempt === maxAttempts) {
        break;
      }
    }
  }
  throw lastErr;
}

/**
 * Create a subfolder inside a parent folder.
 * Returns the new folder metadata { id, name, webViewLink }.
 */
async function createFolder(name, parentFolderId) {
  const drive = getDriveClient();
  return withRetry(async () => {
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId],
      },
      fields: 'id, name, webViewLink',
    });
    return res.data;
  }, `createFolder(${name})`);
}

/**
 * Upload a local file to a Drive folder.
 * Returns file metadata including webViewLink and webContentLink.
 */
async function uploadFile(localPath, folderId, displayName) {
  const drive = getDriveClient();
  const fileName = displayName || basename(localPath);
  const mimeType = fileName.endsWith('.mp3') ? 'audio/mpeg'
    : fileName.endsWith('.mp4') ? 'video/mp4'
    : fileName.endsWith('.json') ? 'application/json'
    : 'application/octet-stream';

  if (!existsSync(localPath)) {
    throw new Error(`File does not exist: ${localPath}`);
  }

  const fileSize = statSync(localPath).size;
  if (fileSize === 0) {
    throw new Error(`File is empty (0 bytes): ${localPath}`);
  }

  console.log(`[Drive] Uploading ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB) to folder ${folderId}`);

  const res = await withRetry(async () => {
    return drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType,
        body: createReadStream(localPath),
      },
      fields: 'id, name, webViewLink, webContentLink, size',
    });
  }, `uploadFile(${fileName})`);

  // Make file publicly readable
  try {
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });
  } catch (permErr) {
    console.warn(`[Drive] ⚠️  Could not set public permissions on ${fileName}: ${permErr.message}`);
  }

  console.log(`[Drive] ✅ Uploaded ${fileName}: ${res.data.webViewLink}`);
  return res.data;
}

/**
 * Upload a JSON object as a file to Drive.
 */
async function uploadJson(data, fileName, folderId) {
  const { Readable } = await import('stream');
  const drive = getDriveClient();
  const json = JSON.stringify(data, null, 2);

  const res = await withRetry(async () => {
    const stream = Readable.from([json]);
    return drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        mimeType: 'application/json',
      },
      media: {
        mimeType: 'application/json',
        body: stream,
      },
      fields: 'id, name, webViewLink',
    });
  }, `uploadJson(${fileName})`);

  try {
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch (permErr) {
    console.warn(`[Drive] ⚠️  Could not set public permissions on ${fileName}: ${permErr.message}`);
  }

  return res.data;
}

/**
 * Main upload function — creates folder structure and uploads all assets.
 *
 * @param {string} jobId
 * @param {object} script - The original script data
 * @param {string|null} voiceoverPath - Local path to MP3
 * @param {Array} scenes - [{index, label, localFile, videoUrl, error}]
 * @returns {Promise<object>} Upload manifest with all Drive links
 */
export async function uploadAdAssets(jobId, script, voiceoverPath, scenes) {
  const parentFolderId = config.google.driveFolderId;
  if (!parentFolderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set');

  // Validate drive client upfront to catch credential errors early
  try {
    getDriveClient();
  } catch (err) {
    throw new Error(`Drive client init failed: ${err.message}`);
  }

  const dateSuffix = new Date().toISOString().slice(0, 10);
  const folderName = `${jobId.slice(0, 8)} - ${dateSuffix}`;

  console.log(`[Drive] Creating ad folder: "${folderName}" inside ${parentFolderId}`);

  let adFolder;
  try {
    adFolder = await createFolder(folderName, parentFolderId);
    console.log(`[Drive] Folder created: ${adFolder.webViewLink}`);
  } catch (err) {
    throw new Error(`Failed to create Drive folder: ${err.message}`);
  }

  const manifest = {
    jobId,
    script,
    createdAt: new Date().toISOString(),
    driveFolder: adFolder.webViewLink,
    driveFolderId: adFolder.id,
    voiceover: null,
    scenes: [],
  };

  // Upload voiceover
  if (voiceoverPath) {
    try {
      const voiceoverFile = await uploadFile(voiceoverPath, adFolder.id, 'voiceover.mp3');
      manifest.voiceover = {
        driveFileId: voiceoverFile.id,
        driveUrl: voiceoverFile.webViewLink,
        downloadUrl: voiceoverFile.webContentLink,
      };
    } catch (err) {
      console.error(`[Drive] ⚠️  Voiceover upload failed: ${err.message}`);
      manifest.voiceover = { error: err.message };
    }
  }

  // Upload each video scene
  for (const scene of scenes) {
    if (!scene.localFile) {
      manifest.scenes.push({
        index: scene.index,
        label: scene.label,
        error: scene.error || 'No local file available',
      });
      continue;
    }
    try {
      const sceneFile = await uploadFile(
        scene.localFile,
        adFolder.id,
        `scene-${scene.index}-${scene.label}.mp4`
      );
      manifest.scenes.push({
        index: scene.index,
        label: scene.label,
        prompt: scene.prompt,
        driveFileId: sceneFile.id,
        driveUrl: sceneFile.webViewLink,
        downloadUrl: sceneFile.webContentLink,
        error: null,
      });
    } catch (err) {
      console.error(`[Drive] ⚠️  Scene ${scene.index} upload failed: ${err.message}`);
      manifest.scenes.push({ index: scene.index, label: scene.label, error: err.message });
    }
  }

  // Upload manifest JSON
  try {
    const manifestFile = await uploadJson(manifest, 'manifest.json', adFolder.id);
    manifest.manifestUrl = manifestFile.webViewLink;
    manifest.manifestFileId = manifestFile.id;
  } catch (err) {
    console.error(`[Drive] ⚠️  Manifest upload failed: ${err.message}`);
  }

  const successCount = manifest.scenes.filter(s => !s.error).length;
  console.log(`[Drive] ✅ Upload complete: ${successCount}/${manifest.scenes.length} scenes + voiceover. Folder: ${adFolder.webViewLink}`);
  return manifest;
}
