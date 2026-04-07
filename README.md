# Alta Water Ad Generator 🚰

Automated broadcast-quality ad generator. Takes a Content Studio script and produces:
- 🎙️ Professional voiceover (ElevenLabs)
- 🎬 4 video scenes in 9:16 vertical format (Runway Gen-4)
- ☁️ Organized Google Drive folder with all assets + manifest

**Cost per ad:** ~$1 | **Time per ad:** ~5-10 min

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/generate-ad` | Start generation, returns `jobId` |
| `GET` | `/status/:jobId` | Poll progress |
| `GET` | `/assets/:jobId` | Get Drive links when complete |
| `POST` | `/publish` | Post to dashboard/Meta *(coming soon)* |
| `GET` | `/health` | Health check |

---

## Quick Start

### 1. Install dependencies
```bash
cd altawater-ad-generator
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your API keys
```

Get keys from 1Password:
- `ELEVENLABS_API_KEY` → ElevenLabs account
- `RUNWAY_API_KEY` → Runway account

For Google Drive, set `GOOGLE_SERVICE_ACCOUNT_JSON` to the JSON of the Alfred service account key (one line):
```bash
cat alfred-service-account.json | jq -c . 
```

Set `GOOGLE_DRIVE_FOLDER_ID` to the folder ID from the Google Drive URL where ads should live.

### 3. Start server
```bash
npm start
# or for development:
npm run dev
```

### 4. Generate your first ad
```bash
curl -X POST http://localhost:3000/generate-ad \
  -H "Content-Type: application/json" \
  -d '{
    "hook": "Are you drinking toxic tap water right now?",
    "market": "Utah homeowners worried about water quality",
    "offer": "Free installation + first month free",
    "voiceover": "Your full voiceover script here..."
  }'
```

Response:
```json
{
  "jobId": "abc-123",
  "status": "queued",
  "estimatedMinutes": "5-10",
  "links": {
    "status": "/status/abc-123",
    "assets": "/assets/abc-123"
  }
}
```

### 5. Poll until complete
```bash
curl http://localhost:3000/status/abc-123
```

### 6. Get Drive links
```bash
curl http://localhost:3000/assets/abc-123
```

---

## Script Format

The `/generate-ad` endpoint accepts:

```json
{
  "hook": "Attention-grabbing opening line",
  "market": "Target audience description",
  "offer": "The specific offer/CTA",
  "voiceover": "Full voiceover script (this gets sent to ElevenLabs)",
  "brand": "Alta Water"
}
```

The `voiceover` field is required (or at minimum `hook`). The other fields drive the visual scene prompts for Runway.

---

## Drive Folder Structure

Each ad gets its own folder:
```
[GOOGLE_DRIVE_FOLDER_ID]/
  {jobId} - {YYYY-MM-DD}/
    voiceover.mp3
    scene-0-hook.mp4
    scene-1-problem.mp4
    scene-2-solution.mp4
    scene-3-cta.mp4
    manifest.json
```

All files are shared as "anyone with link can view."

---

## Deploy to Railway

1. Push to GitHub
2. Connect repo in Railway
3. Set all env vars in Railway dashboard
4. Railway auto-deploys on push

The `railway.json` is already configured with health checks and restart policy.

---

## Architecture

```
POST /generate-ad
  → creates job (in-memory, upgrade to Redis for multi-instance)
  → returns jobId immediately

Background pipeline:
  1. ElevenLabs → voiceover.mp3 (30-60s)
  2. Runway Gen-4 → 4 scenes × 5s clips in parallel (~5 min)
  3. Google Drive → upload all + create manifest.json
  → job.status = "complete"
```

For production multi-instance scale, replace the in-memory job store with Redis + Bull queue. The interface is designed to swap this without changing the API.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ELEVENLABS_API_KEY` | ✅ | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | Optional | Default: Rachel (21m00Tcm4TlvDq8ikWAM) |
| `RUNWAY_API_KEY` | ✅ | Runway API key |
| `RUNWAY_MODEL` | Optional | Default: gen4_turbo |
| `RUNWAY_CLIP_DURATION` | Optional | Seconds per clip (default: 5) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ✅ | Full JSON as string |
| `GOOGLE_DRIVE_FOLDER_ID` | ✅ | Drive folder for all ads |
| `PORT` | Optional | Default: 3000 |
| `TEMP_DIR` | Optional | Default: /tmp/altawater-ads |
