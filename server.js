// Production notes:


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


const REVIEW_PROMPT = `You are a career advisor. When given a CV, a target role, and a target geography, review the CV the way an experienced hiring manager would, then produce a short assessment.

First, work out privately: the candidate's seniority level and function, and the 4-5 things a hiring manager for this specific role would actually check on a CV (choose what's relevant to this role, don't use a fixed generic list).

Then output, in this order:

- For each of the 4-5 checks: the name of what you're checking, a read of Thin / Developing / Convincing, and one sentence why, tied to something actually in the CV.
- VERDICT: 2-3 sentences on where this person realistically stands for this role right now.
- ONE PRIORITY: the single biggest gap holding them back, and the one concrete fix.

Rules: never invent CV content not present in the source. No scores, no percentages, tiers only. Plain, direct language, no hype, no filler praise. Keep the whole output under 280 words.`;

const SUPPORTED_EXTENSIONS = ['.docx', '.pdf'];


const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,24}/;
const PHONE_REGEX = /(\+?\d[\d\s().-]{7,}\d)/;


const SECTION_HEADINGS = new Set([
  'education', 'skills', 'technical skills', 'soft skills', 'core competencies', 'competencies',
  'contact', 'contact information', 'contact details', 'personal details', 'personal information',
  'experience', 'work experience', 'professional experience', 'work history', 'employment',
  'employment history', 'career', 'career history', 'internships', 'internship',
  'certifications', 'certification', 'courses', 'training', 'qualifications',
  'academic qualifications', 'projects', 'project', 'portfolio',
  'summary', 'professional summary', 'career summary', 'objective', 'career objective',
  'profile', 'about', 'about me', 'declaration',
  'achievements', 'key achievements', 'accomplishments', 'awards', 'honors', 'awards and honors',
  'languages', 'interests', 'hobbies', 'activities', 'extracurricular', 'references',
  'publications', 'volunteer', 'volunteering', 'strengths', 'expertise', 'areas of expertise',
  'leadership', 'affiliations', 'memberships',
]);


// Lowercase letters only — canonical form for comparing text against the email local-part.
function letters(s) {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

function cleanNameLine(line) {
  return line.replace(/[^A-Za-z'’\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Headline names are often typeset letter-spaced, so PDF extraction yields
// "P A Y A L  A D W A N I". Collapse mostly-single-letter lines: 2+ space gaps
// delimit words, single spaces within a group are removed.
function isLetterSpaced(line) {
  const tokens = line.trim().split(/\s+/);
  const singles = tokens.filter((t) => /^[A-Za-z]$/.test(t)).length;
  return tokens.length >= 4 && singles / tokens.length >= 0.7;
}

function collapseSpacedLetters(line) {
  if (!isLetterSpaced(line)) return line;
  return line
    .trim()
    .split(/\s{2,}/)
    .map((group) => group.replace(/\s+/g, ''))
    .join(' ');
}


function nameWords(line) {
  return cleanNameLine(line)
    .split(' ')
    .filter((w) => w.length >= 2 && /^[A-Za-z][A-Za-z'’-]*$/.test(w));
}

function isNameCandidate(line) {
  const words = line.split(' ').filter(Boolean);
  return (
    line.length >= 3 &&
    line.length <= 40 &&
    words.length >= 2 &&
    words.length <= 4 &&
    !SECTION_HEADINGS.has(line.toLowerCase()) &&
    words.every((w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w))
  );
}


function detectName(lines, email) {
  if (email) {
    const localPart = letters(email.split('@')[0]);
    let best = null;
    for (const line of lines) {
      if (EMAIL_REGEX.test(line)) continue;
      const words = nameWords(line);
      // Windows of 1-4 adjacent words whose letters appear contiguously in the email
      // local-part. Sizes 2-4 (min 5 letters) catch normal and merged lines. Size 1
      // catches names the PDF glued into a single token ("PAYALADWANI") — held to a
      // stricter bar (not a section heading, covers ≥80% of the local-part) so incidental
      // words like "CONTACT" inside "hr.contact99" can't match.
      for (let size = Math.min(4, words.length); size >= 1; size--) {
        for (let i = 0; i + size <= words.length; i++) {
          const window = words.slice(i, i + size);
          const concat = letters(window.join(''));
          const strongEnough =
            size === 1
              ? concat.length >= 6 &&
                concat.length >= localPart.length * 0.8 &&
                !SECTION_HEADINGS.has(window[0].toLowerCase())
              : concat.length >= 5;
          if (strongEnough && localPart.includes(concat)) {
            const candidate = window.join(' ');
            if (!best || candidate.length > best.length) best = candidate;
          }
        }
      }
    }
    if (best) return best;
  }

  for (const line of lines) {
    if (EMAIL_REGEX.test(line) || /\d/.test(line)) continue;
    const cleaned = cleanNameLine(line);
    if (isNameCandidate(cleaned)) return cleaned;
  }
  return null;
}

function extractPII(text) {
  const lines = text
    .split('\n')
    .map((l) => collapseSpacedLetters(l.trim()))
    .filter(Boolean);
  const emailMatch = text.match(EMAIL_REGEX);
  const phoneMatch = text.match(PHONE_REGEX);
  const email = emailMatch ? emailMatch[0] : null;

  return {
    name: detectName(lines, email),
    email,
    phone: phoneMatch ? phoneMatch[0].trim() : null,
  };
}

// Strips the locally-detected identifiers out of the text before it ever reaches the AI provider.
function redactPII(text, pii) {
  let redacted = text;
  if (pii.name) {
    redacted = redacted.split(pii.name).join('[REDACTED NAME]');
    // The name may have been detected from a collapsed letter-spaced/glued line, in which
    // case it doesn't appear verbatim above — redact any raw line whose letters match it.
    const nameLetters = letters(pii.name);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && trimmed !== pii.name && letters(trimmed) === nameLetters) {
        redacted = redacted.split(trimmed).join('[REDACTED NAME]');
      }
    }
  }
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
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}

module.exports = app;
// Exported for local testing of the PII heuristics.
module.exports.extractPII = extractPII;
module.exports.redactPII = redactPII;
