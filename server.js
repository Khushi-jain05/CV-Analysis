// Production notes:
// - API key: the Groq key only ever lives here on the server, read from an env var / secrets
//   manager (never sent to or embedded in the browser bundle). In production I'd load it via the
//   platform's secret store (e.g. AWS Secrets Manager, Vercel/Render env vars) with rotation, not a
//   plain .env file committed anywhere.
// - Personal data: name/email/phone are detected locally (see extractPII below) and redacted from
//   the text before it is sent to Groq, so the third-party AI provider never sees them — the
//   redacted values are re-attached to the response purely from local extraction, not from the AI.
//   The detection here is a simple heuristic good enough for a demo; production would swap it for a
//   proper NER/PII-detection library and also confirm a no-training/no-retention agreement with Groq.

require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
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

const SUPPORTED_EXTENSIONS = ['.docx', '.pdf'];

// TLD restricted to lowercase so a glued-on word right after the email (e.g. a resume
// header with no space before "LinkedIn") isn't swallowed into the match.
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,24}/;
const PHONE_REGEX = /(\+?\d[\d\s().-]{7,}\d)/;

// Heuristic, local-only PII detection — good enough for a demo. A production build would
// use a proper NER/PII-detection library instead of a short-plain-line-is-the-name guess.
function looksLikeName(line) {
  return (
    line.length > 0 &&
    line.length <= 60 &&
    line.split(/\s+/).length <= 5 &&
    !EMAIL_REGEX.test(line) &&
    !/\d/.test(line)
  );
}

function extractPII(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const name = lines.find(looksLikeName) || null;

  const emailMatch = text.match(EMAIL_REGEX);
  const phoneMatch = text.match(PHONE_REGEX);

  return {
    name,
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0].trim() : null,
  };
}

// Strips the locally-detected identifiers out of the text before it ever reaches the AI provider.
function redactPII(text, pii) {
  let redacted = text;
  if (pii.name) redacted = redacted.split(pii.name).join('[REDACTED NAME]');
  if (pii.email) redacted = redacted.split(pii.email).join('[REDACTED EMAIL]');
  if (pii.phone) redacted = redacted.split(pii.phone).join('[REDACTED PHONE]');
  return redacted;
}

app.use(express.static('public'));

app.post('/api/analyze', upload.single('cv'), async (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ error: 'No CV file was uploaded.' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: 'Unsupported file type. Please upload a .docx or .pdf file.' });
  }

  const targetRole = (req.body.targetRole || '').trim();
  const targetGeography = (req.body.targetGeography || '').trim();

  let cvText;
  try {
    if (ext === '.pdf') {
      const { text } = await pdfParse(req.file.buffer);
      cvText = text.trim();
    } else {
      const { value } = await mammoth.extractRawText({ buffer: req.file.buffer });
      cvText = value.trim();
    }
  } catch (err) {
    return res.status(400).json({ error: 'Could not read the uploaded file. Please upload a valid .docx or .pdf file.' });
  }

  if (!cvText) {
    return res.status(400).json({ error: 'The uploaded file did not contain any readable text.' });
  }

  const pii = extractPII(cvText);
  const redactedText = redactPII(cvText, pii);

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: REVIEW_PROMPT },
        {
          role: 'user',
          content: `Target role: ${targetRole || 'Not specified'}\nTarget geography: ${targetGeography || 'Not specified'}\n\nNote: personal identifiers (name/email/phone) have already been redacted from the CV text below for privacy.\n\nCV:\n${redactedText}`,
        },
      ],
    });

    const result = completion.choices[0].message.content;
    res.json({ result, candidate: pii });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'The AI request failed. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
