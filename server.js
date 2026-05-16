require('dotenv').config({ override: true });
const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { jsonrepair } = require('jsonrepair');

// ── SUPABASE CLIENT ───────────────────────────────────────────────────────────

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('\n  ✗  SUPABASE_URL and SUPABASE_ANON_KEY are required in .env\n');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ── EXPRESS SETUP ─────────────────────────────────────────────────────────────

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DATA API ──────────────────────────────────────────────────────────────────

// GET all keys — called once on page load to hydrate the frontend cache
app.get('/api/data', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_data')
      .select('key, value');
    if (error) throw error;
    const result = {};
    (data || []).forEach(row => { result[row.key] = row.value; });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a single key
app.get('/api/data/:key', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_data')
      .select('value')
      .eq('key', req.params.key)
      .maybeSingle();
    if (error) throw error;
    res.json({ value: data?.value ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST (upsert) a single key
app.post('/api/data/:key', async (req, res) => {
  try {
    const { error } = await supabase
      .from('app_data')
      .upsert(
        { key: req.params.key, value: req.body.value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CLAUDE PROXY ──────────────────────────────────────────────────────────────

app.post('/api/claude', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BIO PARSER ────────────────────────────────────────────────────────────────

app.post('/api/parse-bio', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  }
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const prompt = `You are parsing a designer's LinkedIn profile or resume into structured data.

Extract every job/role from the text below. For each one, also extract 1–3 key projects or achievements worth discussing in a job interview — focus on measurable outcomes, leadership moments, or notable scope.

IMPORTANT: In string values, do NOT use double quotes. Use apostrophes instead if needed. Keep all text clean and JSON-safe.

Return ONLY a valid JSON array of companies (no markdown, no explanation):
[
  {
    "name": "company name",
    "title": "job title",
    "dates": "e.g. 2021 – 2023",
    "industry": "1–3 word industry label",
    "summary": "2–3 sentence summary of role and impact, third person, clean and punchy",
    "projects": [
      {
        "name": "short project or achievement name",
        "metric": "key metric if mentioned, null if none",
        "story": "1–2 sentence description of problem, action, outcome",
        "tags": ["tag1", "tag2"]
      }
    ]
  }
]

Text to parse:
${text}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 6000,
        system: 'You are a career data parser. Respond only with valid JSON arrays. Never use unescaped double quotes inside string values.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'API error');

    let raw = data.content?.[0]?.text || '';
    // Strip markdown code fences if present
    raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // Extract just the array if there's surrounding text
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) raw = arrayMatch[0];
    // Use jsonrepair to fix any malformed JSON
    const repaired = jsonrepair(raw);
    const parsed = JSON.parse(repaired);

    res.json({ companies: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FILE UPLOAD ───────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    let text;
    const name = file.originalname.toLowerCase();

    if (name.endsWith('.pdf')) {
      const parsed = await pdf(file.buffer);
      text = parsed.text;
    } else {
      text = file.buffer.toString('utf8');
    }

    res.json({ text: text.trim(), name: file.originalname });
  } catch (err) {
    res.status(500).json({ error: `Failed to read file: ${err.message}` });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Interview OS  →  http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ⚠  ANTHROPIC_API_KEY not found — AI features will fail\n');
  }
});
