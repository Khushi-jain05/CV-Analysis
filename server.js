// Production notes:
// - API key: the Groq key only ever lives here on the server, read from an env var / secrets
//   manager (never sent to or embedded in the browser bundle). In production I'd load it via the
//   platform's secret store (e.g. AWS Secrets Manager, Vercel/Render env vars) with rotation, not a
//   plain .env file committed anywhere.
// - Personal data: before forwarding CV text to a third-party AI provider, I'd redact or mask direct
//   identifiers (name, email, phone) with placeholders, send the redacted text for analysis, and
//   confirm the provider has a no-training/no-retention data processing agreement in place.

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const Groq = require('groq-sdk');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Placeholder — replace with the exact prompt text once provided.
const REVIEW_PROMPT = `You are a career advisor. When given a CV, a target role, and a target geography, review the CV the way an experienced hiring manager would, then produce a short assessment.

First, work out privately: the candidate's seniority level and function, and the 4-5 things a hiring manager for this specific role would actually check on a CV (choose what's relevant to this role, don't use a fixed generic list).

Then output, in this order:

- For each of the 4-5 checks: the name of what you're checking, a read of Thin / Developing / Convincing, and one sentence why, tied to something actually in the CV.
- VERDICT: 2-3 sentences on where this person realistically stands for this role right now.
- ONE PRIORITY: the single biggest gap holding them back, and the one concrete fix.

Rules: never invent CV content not present in the source. No scores, no percentages, tiers only. Plain, direct language, no hype, no filler praise. Keep the whole output under 280 words.`;

app.use(express.static('public'));

app.post('/api/analyze', upload.single('cv'), async (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ error: 'No CV file was uploaded.' });
  }

  const targetRole = (req.body.targetRole || '').trim();
  const targetGeography = (req.body.targetGeography || '').trim();

  let cvText;
  try {
    const { value } = await mammoth.extractRawText({ buffer: req.file.buffer });
    cvText = value.trim();
  } catch (err) {
    return res.status(400).json({ error: 'Could not read the uploaded file. Please upload a valid .docx file.' });
  }

  if (!cvText) {
    return res.status(400).json({ error: 'The uploaded file did not contain any readable text.' });
  }

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: REVIEW_PROMPT },
        {
          role: 'user',
          content: `Target role: ${targetRole || 'Not specified'}\nTarget geography: ${targetGeography || 'Not specified'}\n\nCV:\n${cvText}`,
        },
      ],
    });

    const result = completion.choices[0].message.content;
    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'The AI request failed. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
