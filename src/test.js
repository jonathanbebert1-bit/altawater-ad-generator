/**
 * Quick smoke test — POST a sample script to the local server.
 * Run: node src/test.js
 * Make sure the server is running first: npm start
 */

const BASE = process.env.TEST_URL || 'http://localhost:3000';

const sampleScript = {
  hook: 'Are you drinking toxic tap water right now?',
  market: 'Utah homeowners concerned about PFAS and chlorine in their water supply',
  offer: 'Get Alta Water installed free — zero down, just $49/month. Cancel anytime.',
  voiceover: `Did you know most Utah tap water contains chlorine, fluoride, and trace heavy metals? 
Your family deserves better. Alta Water's whole-home filtration system removes 99% of contaminants — 
crystal clear, great-tasting water from every tap. Right now we're offering free installation 
with your first month free. No contracts. No risk. Just pure water. Call or text us today 
and we'll have your system installed within 48 hours. Your family's health is worth it.`,
  brand: 'Alta Water',
};

async function run() {
  console.log('🚰 Alta Water Ad Generator — Smoke Test\n');

  // 1. Health check
  const health = await fetch(`${BASE}/health`).then(r => r.json());
  console.log('✅ Health:', health.status);

  // 2. Submit job
  console.log('\n📤 Submitting ad generation job...');
  const job = await fetch(`${BASE}/generate-ad`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sampleScript),
  }).then(r => r.json());

  console.log('Job created:', job.jobId);
  console.log('Status:', job.status);
  console.log('Poll:', `${BASE}${job.links.status}`);

  // 3. Poll status a few times
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await fetch(`${BASE}/status/${job.jobId}`).then(r => r.json());
    console.log(`\n[Poll ${i + 1}] Status: ${status.status}`);
    console.log('  Voiceover:', status.steps.voiceover.status);
    console.log('  Video:', status.steps.video.status);
    console.log('  Upload:', status.steps.upload.status);
  }

  console.log('\n✅ Smoke test complete. Job is running in background.');
  console.log(`   Keep polling: GET ${BASE}/status/${job.jobId}`);
  console.log(`   Assets when done: GET ${BASE}/assets/${job.jobId}`);
}

run().catch(console.error);
