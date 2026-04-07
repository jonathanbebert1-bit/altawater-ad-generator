/**
 * Google Drive upload utilities.
 * Uses a service account (Domain-Wide Delegation) to upload assets
 * into an organized folder structure under the configured parent folder.
 *
 * Folder structure per ad:
 *   GOOGLE_DRIVE_FOLDER_ID/
 *     Alta Water Ads/
 *       {jobId} - {YYYY-MM-DD}/
 *         voiceover.mp3
 *         scene-0-hook.mp4
 *         scene-1-problem.mp4
 *         scene-2-solution.mp4
 *         scene-3-cta.mp4
 *         manifest.json
 */

import { google } from 'googleapis';
import { createReadStream, statSync } from 'fs';
import { basename } from 'path';
import { config } from './config.js';

let driveClient = null;

function getDriveClient() {
  if (driveClient) return driveClient;

  let credentials;
  try {
    credentials = JSON.parse(config.google.serviceAccountJson);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Create a subfolder inside a parent folder.
 * Returns the new folder ID.
 */
async function createFolder(name, parentFolderId) {
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink',
  });
  return res.data;
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

  const fileSize = statSync(localPath).size;
  console.log(`[Drive] Uploading ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB) to folder ${folderId}`);

  const res = await drive.files.create({
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

  // Make file publicly readable (anyone with link)
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

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
  const stream = Readable.from([json]);

  const res = await drive.files.create({
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

  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

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

  const dateSuffix = new Date().toISOString().slice(0, 10);
  const folderName = `${jobId} - ${dateSuffix}`;

  console.log(`[Drive] Creating ad folder: "${folderName}"`);
  const adFolder = await createFolder(folderName, parentFolderId);
  console.log(`[Drive] Folder created: ${adFolder.webViewLink}`);

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
      manifest.scenes.push({ index: scene.index, label: scene.label, error: scene.error });
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

  console.log(`[Drive] ✅ All assets uploaded. Folder: ${adFolder.webViewLink}`);
  return manifest;
}
