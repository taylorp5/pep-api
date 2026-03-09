const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { spawn } = require("child_process");

dotenv.config();

// Temp directory for pep audio files (served by URL, then deleted after send)
const PEP_AUDIO_TEMP_DIR = process.env.PEP_AUDIO_TEMP_DIR || path.join(process.cwd(), "data", "pep-audio");

/** Speech-friendly MP3 bitrate (64-96 kbps). */
const TTS_MP3_BITRATE_KBPS = 80;

/**
 * Re-encode MP3 to speech-friendly bitrate. If ffmpeg fails, returns original buffer.
 */
function reencodeMp3ToSpeechBitrate(inputBuffer) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (buf) => {
      if (!settled) {
        settled = true;
        resolve(buf);
      }
    };
    const args = [
      "-loglevel", "error", "-nostats",
      "-i", "pipe:0",
      "-b:a", `${TTS_MP3_BITRATE_KBPS}k`,
      "-f", "mp3",
      "pipe:1",
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    ff.stdout.on("data", (chunk) => chunks.push(chunk));
    ff.stdout.on("end", () => {
      if (chunks.length > 0) finish(Buffer.concat(chunks));
      else finish(inputBuffer);
    });
    ff.on("error", () => finish(inputBuffer));
    ff.stderr.on("data", (d) => { if (d.toString().trim()) console.warn("[ffmpeg bitrate]", d.toString().trim()); });
    ff.on("close", (code) => {
      if (!settled) {
        if (code === 0 && chunks.length > 0) finish(Buffer.concat(chunks));
        else finish(inputBuffer);
      }
    });
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

/**
 * Get duration in seconds of an MP3 buffer via ffprobe. Returns null if ffprobe fails or is unavailable.
 */
function getMp3DurationSeconds(mp3Buffer) {
  return new Promise((resolve) => {
    const tmpFile = path.join(PEP_AUDIO_TEMP_DIR, `_probe_${Date.now()}.mp3`);
    const dir = path.dirname(tmpFile);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { resolve(null); return; }
    }
    fs.writeFile(tmpFile, mp3Buffer, (err) => {
      if (err) { resolve(null); return; }
      const ff = spawn("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", tmpFile,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      ff.stdout.on("data", (d) => { out += d.toString(); });
      ff.on("error", () => { fs.unlink(tmpFile, () => {}); resolve(null); });
      ff.on("close", (code) => {
        fs.unlink(tmpFile, () => {});
        if (code !== 0) { resolve(null); return; }
        const sec = parseFloat(out.trim());
        resolve(Number.isFinite(sec) ? sec : null);
      });
    });
  });
}

/** Target LUFS for speech (broadcast-style consistent volume). */
const TTS_LUFS_TARGET = -16;
/** True peak ceiling in dBFS to prevent clipping. */
const TTS_TRUE_PEAK_DBFS = -1;
/** Loudness range for speech (maintains dynamic range). */
const TTS_LRA = 11;

/**
 * Normalize audio buffer to -16 LUFS equivalent (speech). No clipping; preserves dynamic range.
 * If ffmpeg is unavailable or fails, returns the original buffer.
 * @param {Buffer} inputBuffer - MP3 (or decodable) audio
 * @returns {Promise<Buffer>} Normalized MP3 or original on skip/failure
 */
function normalizeAudioToLufs(inputBuffer) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (buf) => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };
    const args = [
      "-loglevel", "error", "-nostats",
      "-i", "pipe:0",
      "-af", `loudnorm=I=${TTS_LUFS_TARGET}:TP=${TTS_TRUE_PEAK_DBFS}:LRA=${TTS_LRA}`,
      "-f", "mp3",
      "pipe:1",
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    ff.stdout.on("data", (chunk) => chunks.push(chunk));
    ff.stdout.on("end", () => {
      if (chunks.length > 0) {
        finish(Buffer.concat(chunks));
      } else {
        finish(inputBuffer);
      }
    });
    ff.on("error", (err) => {
      console.warn("[WARN] ", err.message);
      finish(inputBuffer);
    });
    ff.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn("[ffmpeg]", msg);
    });
    ff.on("close", (code) => {
      if (!settled) {
        if (code === 0 && chunks.length > 0) {
          finish(Buffer.concat(chunks));
        } else {
          finish(inputBuffer);
        }
      }
    });
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
// Trust proxy to get real client IP
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// Simple root route for connectivity checks
app.get("/", (req, res) => {
  res.send("Pep API is running. Use POST /pep or POST /tts.");
});

// ===== Delivery cue parsing (optional [PAUSE 0.8], [BEAT] in scripts) =====
const CUE_REGEX = /(\[PAUSE\s+[\d.]+\]|\[BEAT\])/g;
const BEAT_SECONDS = 0.3;

/** Remove cue tokens for display/reading (clean text, no cues). */
function stripCuesToDisplay(script) {
  if (!script || typeof script !== "string") return script;
  return script
    .replace(/\s*\[PAUSE\s+[\d.]+\]\s*/g, "\n\n")
    .replace(/\s*\[BEAT\]\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove cue tokens for TTS input (cues not sent to TTS). Preserve blank lines for pacing. */
function stripCuesForTts(script) {
  if (!script || typeof script !== "string") return script;
  return script
    .replace(/\s*\[PAUSE\s+[\d.]+\]\s*/g, "\n\n")
    .replace(/\s*\[BEAT\]\s*/g, "\n")
    .trim();
}

/**
 * Ensure the script ends on a complete sentence for reading view.
 * If there's a short, trailing fragment after the last sentence-ending punctuation,
 * drop that fragment so we don't end mid-sentence (e.g. "you'll").
 */
function ensureEndsOnSentence(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  const lastPunctIndex = Math.max(
    trimmed.lastIndexOf("."),
    trimmed.lastIndexOf("!"),
    trimmed.lastIndexOf("?")
  );
  if (lastPunctIndex === -1) {
    // No clear sentence boundary; return as-is
    return trimmed;
  }
  const tail = trimmed.slice(lastPunctIndex + 1).trim();
  // If tail is a very short fragment (and not a complete short sentence like "Now." or "Go."), drop it
  if (tail.length > 0 && tail.length <= 25 && !/[.!?]$/.test(tail)) {
    return trimmed.slice(0, lastPunctIndex + 1).trim();
  }
  return trimmed;
}

/** Parse cue token to pause duration in seconds. */
function parseCueSeconds(cue) {
  if (cue === "[BEAT]") return BEAT_SECONDS;
  const m = cue.match(/\[PAUSE\s+([\d.]+)\]/);
  if (m) return Math.min(5, Math.max(0.1, parseFloat(m[1]) || BEAT_SECONDS));
  return BEAT_SECONDS;
}

/**
 * Split script by delivery cues; return [{ text, pauseAfterSeconds }].
 * Cues are not included in text (so TTS never receives them).
 * If no cues are found, fall back to blank-line split with default pause.
 */
function parseScriptWithCues(script, defaultPauseSeconds) {
  if (!script || typeof script !== "string") return [];
  const hasCues = CUE_REGEX.test(script);
  CUE_REGEX.lastIndex = 0;
  if (hasCues) {
    const parts = script.split(CUE_REGEX);
    const segments = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        const text = parts[i].trim();
        const pauseAfter =
          i + 1 < parts.length ? parseCueSeconds(parts[i + 1]) : defaultPauseSeconds;
        if (text) segments.push({ text, pauseAfterSeconds: pauseAfter });
      }
    }
    if (segments.length > 0) return segments;
  }
  const byBlank = script.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  return byBlank.map((text) => ({ text, pauseAfterSeconds: defaultPauseSeconds }));
}

// ===== Usage Logging & Rate Limiting =====

// Daily counters (reset at midnight)
let dailyCounts = {
  free: 0,
  pro: 0,
  lastResetDate: null,
};

// Rate limiting per IP (in-memory)
const rateLimitMap = new Map(); // IP -> { requests: [], lastCleanup: timestamp }

// Get today's date as YYYY-MM-DD
const getTodayDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

// Reset daily counts if date changed
const checkAndResetDailyCounts = () => {
  const today = getTodayDate();
  if (dailyCounts.lastResetDate !== today) {
    console.log(`[INFO] Resetting daily counts (was ${dailyCounts.lastResetDate}, now ${today})`);
    dailyCounts = {
      free: 0,
      pro: 0,
      lastResetDate: today,
    };
  }
};

// Clean up old rate limit entries (older than 1 hour)
const cleanupRateLimits = () => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [ip, data] of rateLimitMap.entries()) {
    // Remove requests older than 1 hour
    data.requests = data.requests.filter((timestamp) => timestamp > oneHourAgo);
    
    // Remove IP entry if no recent requests
    if (data.requests.length === 0) {
      rateLimitMap.delete(ip);
    }
  }
};

// Check rate limit for IP (max 20 requests per hour)
const checkRateLimit = (ip) => {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  
  // Clean up old entries periodically
  if (!rateLimitMap.has(ip) || (rateLimitMap.get(ip).lastCleanup || 0) < now - 5 * 60 * 1000) {
    cleanupRateLimits();
    if (rateLimitMap.has(ip)) {
      rateLimitMap.get(ip).lastCleanup = now;
    }
  }
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { requests: [now], lastCleanup: now });
    return true;
  }
  
  const data = rateLimitMap.get(ip);
  // Filter to only recent requests (within last hour)
  data.requests = data.requests.filter((timestamp) => timestamp > oneHourAgo);
  
  if (data.requests.length >= 20) {
    return false; // Rate limit exceeded
  }
  
  data.requests.push(now);
  return true;
};

// Get client IP from request
const getClientIP = (req) => {
  return req.ip || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress ||
         req.headers['x-forwarded-for']?.split(',')[0] ||
         'unknown';
};

// Usage logging
const logUsage = (mode, scriptTextLength, ip) => {
  const timestamp = new Date().toISOString();
  console.log(`[INFO] Usage: ${timestamp} | IP: ${ip} | Mode: ${mode} | ScriptLength: ${scriptTextLength} chars`);
};

// Initialize daily counts
checkAndResetDailyCounts();

// Daily pep cache (resets when date changes)
let dailyPepCache = {
  date: null,
  data: null,
};

// Generate deterministic daily pep talk
const generateDailyPep = async (date) => {
  // Use date as seed for deterministic generation
  const seed = date; // YYYY-MM-DD format
  
  // Generate topic and quote using OpenAI
  const topicCompletion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Generate a single motivational topic word (1-2 words max) and a short quote (under 10 words) for a daily pep talk.
The topic should be relevant and actionable. The quote should be concise and memorable.
Return ONLY: "Topic: [topic] | Quote: [quote]"
Example: "Topic: Momentum | Quote: Small actions compound."`,
      },
      {
        role: "user",
        content: `Generate topic and quote for date: ${seed}. Make it unique and relevant.`,
      },
    ],
    max_tokens: 30,
    temperature: 0.8,
  });

  const topicQuoteText = topicCompletion.choices[0]?.message?.content?.trim() || "";
  let topic = "Momentum";
  let quote = "Small actions compound.";
  
  // Parse topic and quote from response
  const topicMatch = topicQuoteText.match(/Topic:\s*(.+?)(?:\s*\||$)/i);
  const quoteMatch = topicQuoteText.match(/Quote:\s*(.+?)$/i);
  
  if (topicMatch) topic = topicMatch[1].trim();
  if (quoteMatch) quote = quoteMatch[1].trim().replace(/^["']|["']$/g, '');

  // Generate script based on topic and quote
  const scriptCompletion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a motivational coach who creates authentic, grounded pep talks.
Generate a 30-second pep talk script (approximately 600 characters) based on the topic and quote.

Structure and pacing (abstract rulesâ€”use original wording only):
- Build in a short arc: name the idea â†’ reframe or sharpen it â†’ one clear takeaway or nudge.
- Vary sentence length: mix a longer line with a short punch (one to three words) for impact.
- Use line breaks to create rhythm where it helps; you may use a few short lines for emphasis.
- Land with a single clear, calm lineâ€”no hype, no exclamation points.
- Do NOT copy, paraphrase, or reuse any famous quotes or lines from other speeches. All content must be original.

Rules:
- NO clichÃ©s or generic motivational phrases
- NO yelling or excessive enthusiasm
- NO excessive positivity or toxic positivity
- NO exclamation points
- Use a calm, authentic tone
- Be practical and actionable
- Reference the topic and quote naturally in your own words
- Keep it conversational and natural
- Maximum 600 characters

Return ONLY the script text, no quotes, no formatting, just the raw text.`,
      },
      {
        role: "user",
        content: `Create a pep talk about: ${topic}. Use this quote: "${quote}". Keep it under 600 characters.`,
      },
    ],
    max_tokens: 200, // ~600 chars / 3
    temperature: 0.7,
  });

  let scriptText = scriptCompletion.choices[0]?.message?.content?.trim() || "";
  
  // Ensure it's under 600 characters
  if (scriptText.length > 600) {
    scriptText = scriptText.substring(0, 600);
  }

  // Generate TTS audio
  const mp3 = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: scriptText,
  });

  let buffer = Buffer.from(await mp3.arrayBuffer());
  buffer = await normalizeAudioToLufs(buffer);
  const audioBase64 = buffer.toString("base64");

  return {
    date: date,
    topic: topic,
    quote: quote,
    scriptText: scriptText,
    audioBase64: audioBase64,
  };
};

function ensurePepAudioTempDir() {
  if (!fs.existsSync(PEP_AUDIO_TEMP_DIR)) {
    fs.mkdirSync(PEP_AUDIO_TEMP_DIR, { recursive: true });
    console.log("Created pep audio temp dir:", PEP_AUDIO_TEMP_DIR);
  }
}

function writeTempPepMp3(buffer) {
  ensurePepAudioTempDir();
  const id = `pep_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.mp3`;
  const filePath = path.join(PEP_AUDIO_TEMP_DIR, id);
  fs.writeFileSync(filePath, buffer);
  return id;
}

function getPepAudioUrl(req, fileId) {
  const base = req.protocol + "://" + req.get("host");
  return base.replace(/\/$/, "") + "/pep-audio/" + encodeURIComponent(fileId);
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/daily", async (req, res) => {
  try {
    const today = getTodayDate();
    
    // Check cache - if same date, return cached data
    if (dailyPepCache.date === today && dailyPepCache.data) {
      console.log(`[INFO] Returning cached daily pep for ${today}`);
      return res.json(dailyPepCache.data);
    }

    // Generate new daily pep
    console.log("[INFO] Generating new daily pep for " + today);
    const dailyPep = await generateDailyPep(today);
    
    // Cache it
    dailyPepCache = {
      date: today,
      data: dailyPep,
    };

    console.log("[OK] Daily pep generated: topic=\"" + dailyPep.topic + "\", quote=\"" + dailyPep.quote + "\", script=" + dailyPep.scriptText.length + " chars");
    
    res.json(dailyPep);
  } catch (err) {
    console.error("[FAIL] Daily pep error:", err.message);
    
    // Provide helpful error messages
    if (err.message.includes("API key")) {
      return res.status(500).json({ error: "OpenAI API configuration error. Check API key." });
    }
    if (err.message.includes("rate limit")) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
    }
    if (err.message.includes("timeout")) {
      return res.status(504).json({ error: "Request timeout. Please try again." });
    }

    res.status(500).json({ error: "Daily pep generation failed: " + err.message });
  }
});

app.get("/metrics", (req, res) => {
  checkAndResetDailyCounts();
  res.json({
    date: dailyCounts.lastResetDate,
    counts: {
      free: dailyCounts.free,
      pro: dailyCounts.pro,
      total: dailyCounts.free + dailyCounts.pro,
    },
    limits: {
      maxFree: parseInt(process.env.MAX_FREE_DAILY_REQUESTS || "200", 10),
      maxPro: parseInt(process.env.MAX_PRO_DAILY_REQUESTS || "200", 10),
    },
  });
});

// Safety evaluation function
const evaluateRequestSafety = async (userText, keywordOnly = false) => {
  const lowerText = userText.toLowerCase();
  
  // Enhanced keywords/phrases that indicate harmful content
  // Exclude relationship/emotional context: "fight with boyfriend", "argument with partner" = conflict, not violence
  const relationshipContext = /\b(fight|argument|argued|fight with|argument with)\s+(with\s+)?(my|your)\s+(boyfriend|girlfriend|partner|spouse|husband|wife|friend|family)/i;
  if (relationshipContext.test(userText)) {
    // User is describing a relationship conflict and likely wants support; don't block
  } else {
    const harmfulPatterns = [
      // Self-harm or suicide
      /\b(kill|hurt|harm|injure|suicide|self.?harm|cutting|self.?injury|end.*life|take.*life)\b.*\b(myself|yourself|myself|self|me|my)\b/i,
      /\b(end|take|end it|end my|end your)\b.*\b(life|lives)\b/i,
      // Harm to others (violence) - not "fight with my X" (relationship)
      /\b(kill|hurt|harm|injure|attack|assault|violence|violent|hit|punch|stab|shoot)\b.*\b(someone|other|person|people|them|they|him|her)\b/i,
      /\b(fight|attack|assault)\s+(someone|another|a\s+person|people|stranger)/i,
    // Illegal activity
    /\b(steal|rob|burglar|illegal|drug|weapon|gun|knife|bomb|explosive|break.*law)\b/i,
    // Abuse/harassment/coercion
    /\b(abuse|harass|bully|threaten|coerce|force|manipulate|intimidate|blackmail)\b/i,
    // Dangerous physical behavior
    /\b(dangerous|unsafe|risky|extreme|reckless)\b.*\b(activity|action|behavior|stunt|exercise|workout)\b/i,
    // Ignoring injury or medical advice
    /\b(ignore|ignore.*injury|ignore.*pain|ignore.*doctor|ignore.*medical|work.*through.*injury|push.*through.*pain)\b/i,
    // Starvation or extreme restriction
    /\b(starve|starvation|not.*eat|stop.*eating|extreme.*diet|dangerous.*diet|fast.*too.*long)\b/i,
  ];
  
  // Check for harmful patterns
  for (const pattern of harmfulPatterns) {
    if (pattern.test(userText)) {
      console.log(`[INFO] Pattern match detected: ${pattern}`);
      return { isSafe: false, reason: "harmful_content" };
    }
  }
  }

  // For short peps (30s), skip LLM safety call to save ~2-5s; keyword check above is sufficient
  if (keywordOnly) {
    return { isSafe: true };
  }
  
  // Use OpenAI to evaluate context (more nuanced than keyword matching)
  try {
    const safetyCheck = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a safety evaluator. Analyze the user's request and determine if it encourages or involves:
- Violence or harm to others (actually hurting someone)
- Self-harm or suicide
- Illegal activity
- Harassment, coercion, or abuse
- Dangerous physical behavior (e.g., ignoring injury, starvation, extreme risk)

IMPORTANT: The following are SAFE and should get "SAFE":
- Relationship or emotional context: e.g. "had a fight with my boyfriend/girlfriend/partner", "argument with my spouse", "feeling sad after a disagreement", "breakup", "feeling down after conflict". The user is asking for emotional support or motivation to cope and move forward, not to harm anyone.
- General stress, sadness, anxiety, or life difficulties when the user wants motivation or a pep talk.

If the request is asking for motivation to do something harmful, dangerous, or illegal, respond with "UNSAFE".
If the request is asking for motivation or support for something safe and constructive (including relationship conflict, sadness, or coping), respond with "SAFE".

Respond with ONLY "SAFE" or "UNSAFE" followed by a brief reason (one sentence).`,
        },
        {
          role: "user",
          content: `Evaluate this request: "${userText}"`,
        },
      ],
      max_tokens: 50,
      temperature: 0.3,
    });
    
    const evaluation = safetyCheck.choices[0]?.message?.content?.trim() || "";
    const isUnsafe = evaluation.toUpperCase().startsWith("UNSAFE");
    
    if (isUnsafe) {
      console.log(`[INFO] OpenAI evaluation: ${evaluation}`);
      return { isSafe: false, reason: "evaluated_unsafe" };
    }
  } catch (err) {
    console.error("Safety evaluation error:", err.message);
    // If safety check fails, proceed with caution (log it)
    console.warn("[WARN] ");
  }
  
  return { isSafe: true };
};

// Generate refusal response in Pep's voice
const generateRefusalResponse = async (userText, tone, maxChars) => {
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are Pep, a direct motivational coach. When a request is harmful, dangerous, or illegal, you refuse calmly and firmly while redirecting to something constructive.

Your refusal must:
- Be calm and firm, non-judgmental
- Show authority and respect
- NOT mention "policy", "rules", "I can't help", "I'm not allowed", or "safety"
- Redirect toward a constructive alternative
- Use short paragraphs
- Use declarative sentences
- No exclamation points
- No therapy language
- Maximum ${maxChars} characters

Example refusal tone:
"I'm not going to push you toward something that hurts you or someone else.
But I will help you do something hard that actually helps.
If you want to redirect this toward discipline, restraint, or choosing better, say the word."

Structure:
1. State what you won't do (calm, firm)
2. State what you will do (constructive alternative)
3. Invite them to redirect (brief, direct)

Return ONLY the refusal text, no quotes or formatting.`,
      },
      {
        role: "user",
        content: `The user requested: "${userText}"

Generate a refusal response in Pep's voice that redirects to something constructive.`,
      },
    ],
    max_tokens: Math.floor(maxChars / 2.5),
    temperature: 0.7,
  });

  let refusalText = completion.choices[0]?.message?.content?.trim() || "I'm not going to push you toward something that hurts you or someone else. But I will help you do something hard that actually helps. If you want to redirect this toward discipline, restraint, or choosing better, say the word.";
  
  // Clean up quotes if wrapped
  refusalText = refusalText.replace(/^["']|["']$/g, '').trim();
  
  // Enforce length limit
  if (refusalText.length > maxChars) {
    const truncated = refusalText.substring(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastLineBreak = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastLineBreak);
    
    if (cutPoint > maxChars * 0.7) {
      refusalText = truncated.substring(0, cutPoint + 1);
    } else {
      refusalText = truncated;
    }
  }
  
  return refusalText;
};

/**
 * Expansion pass: expand existing script to target word range without full regenerate.
 * Preserves tone, structure, repetition, and pacing. Call once when initial script is under minimum.
 */
async function expandScriptToTarget(client, existingScript, wordTargets, userText, outcome, obstacle) {
  const minWords = wordTargets.min;
  const maxWords = wordTargets.max;
  const expansionPrompt = `You are Pep. Your job is to EXPAND an existing pep talk script to reach ${minWords}-${maxWords} words.

RULES:
- You will receive the current script. Output the FULL expanded script (the entire talk from start to finish), not a patch.
- Preserve the exact tone, structure, line breaks, repetition patterns, and pacing of the original.
- ADD content: more call-and-response, more repetition blocks, more silence anchors (blank lines), deeper reframes, stronger identity declarations. Do not summarize or cut anything.
- Do not be concise. Do not summarize. You must produce at least ${minWords} words.
- Keep short lines and blank lines. Return ONLY the script, no quotes or labels.`;
  const userContent = `Expand this pep talk to ${minWords}-${maxWords} words. Preserve tone and structure; add content.\n\nContext: ${userText.trim()}${outcome ? `\nOutcome: ${outcome}` : ""}${obstacle ? `\nObstacle: ${obstacle}` : ""}\n\nCURRENT SCRIPT:\n${existingScript}`;
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: expansionPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: Math.ceil(maxWords * 1.2),
    temperature: 0.6,
  });
  const expanded = completion.choices[0]?.message?.content?.trim();
  return expanded ? expanded.replace(/^["']|["']$/g, "").trim() : existingScript;
}

// Shared by /pep and /pep-script for medium/long prompt construction
function getToneSpecificPrompt(tone, wordTargets, outcome, obstacle, isLongForm, intentList, intentOtherText, flowProfileSummary, condensedForSpeed, finalTargetSeconds, needsSpeechBlocks) {
  const tonePrompts = {
    easy: {
      sentenceLength: "Use longer, flowing sentences. Allow for pauses and reflection.",
      vocabulary: "Use validating language: 'it's understandable', 'that makes sense', 'you're feeling', 'it's okay to'. Include permission-based phrasing: 'you can', 'maybe', 'consider', 'perhaps'.",
      opening: "Start with validation and understanding. Acknowledge their struggle gently.",
      closing: "End with a softer, encouraging close. Use phrases like 'You've got this' or 'Take your time'.",
      pacing: "Slower pacing. More space between thoughts. Use longer paragraphs. BREATHING: After each 'Breathe in' or 'Breathe out', put [PAUSE 4] or [PAUSE 5] on its own line so the listener has real time (e.g. 'Breathe in.' newline '[PAUSE 4]' newline 'Breathe out.' newline '[PAUSE 4]'). REPEAT-AFTER-ME: When you say 'Repeat after me' or 'Say it with me', put the phrase on the next line, then [PAUSE 4] on its own line so the user has 4 seconds to say it (e.g. 'Say it with me.' newline 'I am enough.' newline '[PAUSE 4]'). Do not rush; leave room for silence.",
    },
    steady: {
      sentenceLength: "Use medium-length sentences. Balanced rhythm.",
      vocabulary: "Use calm authority: 'you will', 'this is', 'here's what happens'. Include reassurance: 'you can handle this', 'this is manageable', 'you've done hard things before'.",
      opening: "Start with calm acknowledgment. 'I hear you. Here's what's happening.'",
      closing: "End with clear but gentle direction. 'Start here. You've got this.'",
      pacing: "Steady pacing. Clear but not rushed.",
    },
    direct: {
      sentenceLength: "Use medium-length declarative sentences. Clear and factual.",
      vocabulary: "Neutral, factual language. No validation fluff. State what is: 'This is the situation', 'Here's what needs to happen', 'You need to'.",
      opening: "Start directly with the situation. 'Here's what's happening.'",
      closing: "End with clear action. 'Do this. Start now.'",
      pacing: "Direct pacing. No unnecessary words.",
    },
    blunt: {
      sentenceLength: "Use short, punchy sentences. Maximum impact per sentence.",
      vocabulary: "Call out avoidance directly: 'You're avoiding X', 'You're making excuses', 'Stop stalling'. Minimal emotional language. Facts only.",
      opening: "Start by naming the avoidance. 'You're avoiding this.'",
      closing: "End with direct command. 'Do it. Now.'",
      pacing: "Fast, direct pacing. No fluff.",
    },
    no_excuses: {
      sentenceLength: "Use very short, decisive sentences. Break them across multiple lines. Single words on lines for emphasis. Command structure. Write like a live coach speaking to a room.",
      vocabulary: "Firm, 'adjacent-to-swearing' language without profanity. Direct confrontation: 'You're looking for an out', 'You don't need hype', 'No one is coming to save you'. Call out avoidance: 'You've been carrying this decision around instead of making it', 'You don't collapse the moment things feel hard'. Remove comfort language. Be honest, not harsh. Do NOT insult the user.",
      opening: "Start with firm but controlled confrontation. Name what they're avoiding directly. Use short lines. Example: 'You don't want to go. Good. Let's start there.'",
      closing: "End with a slow, spaced call-to-action. Use blank lines for pauses. Example: 'Say it one last time.\n\nI do hard things.' or 'Now move.' Put on its own line after blank lines. No exclamation points.",
      pacing: "SLOW, HEAVY pacing. Heavy use of line breaks. Multiple blank lines between sections create longer pauses. No comfort language. No fluff. Write in beats. For long-form (â‰¥120s), include call-and-response sections, identity declarations, countdowns, and silence anchors.",
      intensityEscalation: "Early: firm but controlled. Middle: confrontational + participatory (call-and-response). End: calm, slow, commanding.",
    },
  };

  const toneRules = tonePrompts[tone] || tonePrompts.direct;

  // Build context string for Flow profile, intents, outcome, and obstacle
  let contextInfo = "";
  if (flowProfileSummary) {
    contextInfo += `\n\nPERSONALIZATION (Flow): ${flowProfileSummary} Use this to make the pep feel tailored to this user. Keep the same structure and guardrails; adapt tone and emphasis to match their preferences.`;
  }
  if (intentList && intentList.length > 0) {
    const intentPhrase = intentList.map((i) => i.toLowerCase()).join(" + ");
    contextInfo += `\n\nIMPORTANT: This pep should explicitly serve these intents: ${intentPhrase}. Weave them into the tone and content. Do not list intents literally; reflect them in how you address the user.`;
    if (intentOtherText) {
      contextInfo += ` The user also described: "${intentOtherText}". Incorporate this intent as well.`;
    }
  }
  if (outcome) {
    contextInfo += `\n\nIMPORTANT: The user's desired outcome is: "${outcome}". This is the win condition. Reflect this explicitly in the pep talk as what they are working toward.`;
  }
  if (obstacle) {
    contextInfo += `\n\nIMPORTANT: The real obstacle is: "${obstacle}". Name it directly and address it head-on in the pep talk.`;
  }

  // Long-form structure (for â‰¥120s)
  let structureGuidance = "";
  const mandatorySpeechBlocksFor60 = `
MANDATORY SPEECH BLOCKS (Direct/No Excuses â‰¥60s - REQUIRED):
You MUST include ALL of the following. These create a live, video-speech feel with natural pauses and repeats.

1. At least 1 CALL-AND-RESPONSE block:
   Use cues like: "Say it with me." / "Again." / "What are you?" / "Repeat after me." / "Tell me."
   Then the phrase to repeat on the next line. After the phrase, put [PAUSE 4] on its own line so the user has 4 seconds to say it. Use short lines.
   Example:
   Say it with me.
   
   I do hard things.
   
   Again.
   
   I do hard things.

2. At least 1 IDENTITY CHANT block:
   One short identity phrase repeated 2â€“4 times (each on its own line or with a blank line between).
   Example:
   I show up.
   
   I show up.
   
   I show up.

3. At least 1 COUNTDOWN or STEPWISE ramp:
   "3â€¦ 2â€¦ 1â€¦ Now." or "One. [action]. Two. [action]. Three. [action]. Go."
   Short lines. Creates rhythm and momentum.
   Example:
   Three.
   
   Two.
   
   One.
   
   Now.

4. At least 3 SILENCE ANCHORS:
   Use extra blank lines (2â€“3 blank lines) around a key line to create intentional silence.
   Place at least 3 of these in the script (e.g. before/after the call-and-response, before the final command, around the identity chant).
   Blank lines are preserved into TTS and create real pausesâ€”do not trim or collapse them.`;

  if (isLongForm) {
    structureGuidance = `

LONG-FORM PROMPT (${finalTargetSeconds}s — ${wordTargets.min}-${wordTargets.max} words). You MUST produce at least ${wordTargets.min} words. Do not be concise. Do not summarize.

REQUIRED SECTIONS (include every one; do not label them in output):

1. CONFRONTATION — Name what they are avoiding. Call out stalling or excuses directly. Short lines. Firm but controlled.

2. REFRAME — Shift perspective: obstacle as choice, failure as information. Remove escape routes. Make the situation clear.

3. REPETITION BLOCK — One key phrase or identity line repeated 2–4 times (each on its own line or with blank lines between). Creates weight and momentum.

4. CALL-AND-RESPONSE — At least 2 sections. Use cues like "Repeat after me." "Say it with me." "What are you?" "Tell me." Put the phrase to repeat on the next line; then [PAUSE 4] on its own line so the listener has time. Short, punchy phrases.

5. IDENTITY DECLARATION — At least 1 block. "I am ___" or "I do ___" patterns. Repeat 2–4 times for emphasis. Own the identity.

6. STRONG CLOSE — End with a calm, slow, decisive command. Final line on its own after 2–3 blank lines. No exclamation points. E.g. "Now move." "Do it." "Go."

PACING: Use 2–3 blank lines between major sections. At least 3 SILENCE ANCHORS (blank lines around key lines). Preserve all blank lines into TTS. Write for SLOW, deliberate delivery.

CRITICAL: Do not be concise. Do not summarize. You must produce at least ${wordTargets.min} words. Expand fully. Write SLOWLY and HEAVILY.`;
  } else if (needsSpeechBlocks) {
    structureGuidance = `\n\nSTRUCTURE (Direct/No Excuses â‰¥60s - short lines, live speech feel):
1. Name the resistance - what's blocking them (short lines, tone-appropriate opening)
2. Reframe - shift perspective (short lines, no long paragraphs)
3. Include the MANDATORY SPEECH BLOCKS below
4. Strong close - slow, spaced call-to-action with silence anchors
${mandatorySpeechBlocksFor60}

Use SHORT LINES only. No long paragraphs. No sentence longer than 15 words. Preserve blank lines for TTS pauses.`;
  } else {
    structureGuidance = `\n\nSTRUCTURE:
1. Name the resistance - identify what's blocking them (use tone-appropriate opening)
2. Reframe - shift perspective on the situation
3. Clear next step - what they need to do
4. Strong close - end with tone-appropriate closing`;
  }

  // Condensed long-form prompt (120s/180s): same content, fewer tokens for faster generation
  if (condensedForSpeed) {
    return `You are Pep, a direct motivational coach. Generate a pep talk: ${wordTargets.min}-${wordTargets.max} words (~${finalTargetSeconds}s when spoken).${contextInfo}

ORIGINALITY: Fully original. No copying, paraphrasing, or famous quotes. Create your own phrasing and imagery.

STRUCTURE: Build arcâ€”name situation â†’ reframe â†’ raise stakes â†’ ownership/choice â†’ decisive close. Use short lines and blank lines for rhythm. Vary sentence length; single-word lines for impact. Call-and-response when fitting. Write for a listener; create a moment of choice with your own wording.

CRITICAL LENGTH: You must produce at least ${wordTargets.min} words. Do not be concise. Do not summarize. Hit ${wordTargets.min}-${wordTargets.max} words. Expand fully. Only trim if over ${Math.floor(wordTargets.max * 1.1)} words.

WRITING: Beats, not paragraphs. Short lines; blank lines = pauses. No sentence >15 words for direct/no_excuses. No exclamation points.

TONE ("${tone}"): ${toneRules.sentenceLength} ${toneRules.vocabulary} OPENING: ${toneRules.opening} CLOSING: ${toneRules.closing} PACING: ${toneRules.pacing}${toneRules.intensityEscalation ? ` INTENSITY: ${toneRules.intensityEscalation}` : ""}
${structureGuidance}

ENDING: Last line must be a complete closing (e.g. "Do it." "Now."). Never end mid-thought or with a question. Final command on its own line after blank lines. No exclamation points.

PACING FOR 120s/180s: Write for SLOW, deliberate delivery. Use 2-3 blank lines between major sections. For easy/calm tone, when you include breathing or body exercises, add [PAUSE 4] or [PAUSE 5] on its own line after each step (e.g. after "Breathe in." and "Breathe out.") so the listener has real time to follow. Optional: [PAUSE 0.8] or [BEAT] for shorter pauses; they are stripped for TTS.

OUTPUT: Short lines, blank lines between sections. Preserve blank lines. Return ONLY the script. No quotes. Target ${wordTargets.min}-${wordTargets.max} words. Original only. Safe and motivational.`;
  }

  return `You are Pep, a direct motivational coach who creates real motivational speeches.

Generate a pep talk script targeting ${wordTargets.min}-${wordTargets.max} words (approximately ${finalTargetSeconds} seconds when spoken).${contextInfo}

ORIGINALITY (NON-NEGOTIABLE):
- Do NOT copy, paraphrase, imitate, or replicate any existing speeches, quotes, or famous lines.
- Do NOT reuse specific metaphors, catchphrases, or identifiable stylistic tics from other speakers.
- All phrasing, examples, and imagery must be your own. Create completely original content.

STRUCTURAL & RHETORICAL RULES (ABSTRACT â€” APPLY THESE PATTERNS WITH ORIGINAL CONTENT):

1. PACING & INTENSITY PROGRESSION:
   - Build in a clear arc: name the situation â†’ reframe it â†’ raise stakes â†’ ownership/choice â†’ decisive close.
   - Vary sentence length deliberately: use a longer setup line, then a one- or two-word beat for impact.
   - Allow intensity to rise through the middle, then land with a calmer, definitive final section.
   - Use line breaks and blank lines to create rhythm: short bursts, then space, then the next beat.

2. REPETITION (STRATEGIC, NOT DERIVATIVE):
   - Use triples for emphasis (same structure three times with fresh wording each time).
   - Use anaphora sparingly: same opening phrase across 2â€“3 lines, then break the pattern.
   - Bring back a key idea once later in the talk as a refrainâ€”rephrase it, do not quote yourself.
   - Never recycle famous phrases from other speeches; invent new patterns that feel live and direct.

3. MOMENTUM & ESCALATION:
   - Early: Acknowledge the difficulty or resistance in plain terms.
   - Middle: Reframe (e.g. obstacle as choice, failure as information) and remove escape routes.
   - Build: Identity or choice framing ("what you do when X" / "the kind of person who Y") with original language.
   - Peak: Short, repeated declarations or a call-and-response blockâ€”all original.
   - End: One clear, calm line or command. No hype; land with certainty.

4. CALL-AND-RESPONSE (WHEN FITTING):
   - Invite a repeated phrase with a short cue (e.g. "Say it." / "Again."). Use your own prompts and answers.
   - Rhetorical questions are fine; follow with a short answer or a beat of silence (blank line), then the next idea.
   - Keep call-and-response phrases short and repeatable; never borrow from existing speeches.

5. SENTENCE LENGTH CONTRAST:
   - Mix long and short. After a multi-clause thought, use a single word or short phrase on the next line.
   - Use lists of parallel short clauses to build; then one longer line to land or pivot.
   - Single-word lines are for emphasis only; use sparingly and only where they earn the pause.

6. PERFORMANCE-ORIENTED, CINEMATIC FEEL:
   - Write for a listener, not a reader. Every line should sound like it's spoken in a room.
   - Create a "moment of choice" or "moment of decision" without using those exact clichÃ©sâ€”make the turn in the talk feel like a hinge.
   - Use binary contrast (two clear options or outcomes) with your own wording; avoid stock phrases.
   - The talk should feel like it builds to a peak and then resolves, not like a flat list of tips.

CRITICAL LENGTH REQUIREMENTS:
- You must produce at least ${wordTargets.min} words. Do not be concise. Do not summarize.
- Hit the target word count range (${wordTargets.min}-${wordTargets.max} words). Expand ideas fully.
- Only trim if output exceeds ${Math.floor(wordTargets.max * 1.1)} words (never trim long-form unless over max by >10%).

WRITING STYLE - GOLD STANDARD (MANDATORY):

Write in BEATS, not paragraphs. Never write long continuous paragraphs.

Write like a LIVE MOTIVATIONAL SPEECH / video speechâ€”punchy, with natural pauses and repeats.

Use SHORT LINES and INTENTIONAL PAUSES:
- Single words on their own lines for emphasis
- Two to three word lines for impact
- Short sentences broken across multiple lines (no sentence longer than 15 words for direct/no_excuses)
- Blank lines between sections create longer pauses (use 2-3 blank lines for silence anchors)
- Line breaks are your primary pacing tool
- For Direct and No Excuses (especially â‰¥60s): Use ONLY short lines and beats. No long paragraphs. No run-on sentences.

Example structure:
"You don't want to go.

Good.
Let's start there.

Because pretending would be a lie.
And this isn't about lying.

It's about deciding who's in charge."

NOT like this:
"You don't want to go, and that's okay. Let's start there because pretending would be a lie. This isn't about lying to yourself, it's about deciding who's in charge today."

TONE-SPECIFIC RULES FOR "${tone.toUpperCase()}":
- SENTENCE LENGTH: ${toneRules.sentenceLength}
- VOCABULARY: ${toneRules.vocabulary}
- OPENING: ${toneRules.opening}
- CLOSING: ${toneRules.closing}
- PACING: ${toneRules.pacing}

SPEECH-FIRST WRITING (CRITICAL):
- Write for SPOKEN delivery, not reading
- Write like a LIVE COACH speaking to a room
- Every line break creates a pause in TTS
- Use blank lines between major sections (2-3 blank lines for longer pauses)
- Break thoughts across multiple lines for emphasis
- Single words on lines for maximum impact
- Use repetition for emphasis
- Write like a spoken performance, not an essay
- For No Excuses: SLOW, HEAVY pacing. Make it feel deliberate and powerful.

LANGUAGE INTENSITY (for "no_excuses" tone):
- Firm, "adjacent-to-swearing" language without profanity
- Direct confrontation: "You're looking for an out." / "You don't need hype."
- Call out avoidance: "You've been carrying this decision around instead of making it."
- Remove comfort language and permission-seeking
- Be honest, not harsh: "That's normal. But normal isn't the goal."

PUNCTUATION & PACING:
- Use punctuation intentionally for pacing
- Periods create pauses. Commas create brief pauses.
- Line breaks create longer pauses
- Blank lines create the longest pauses
- No exclamation points (ever)
- No excessive enthusiasm or yelling

${structureGuidance}

ENDING (CRITICAL - AVOID ABRUPT CUTOFF):
- The LAST LINE must be a complete, decisive closing with a clear tone of finality. Never end mid-thought, mid-sentence, or with an open-ended question.
- End with one short, commanding line (e.g. "Now." "Go." "Do it." "You've got this.") so the pep lands as complete. The final line must be spoken in full and not cut off.
- End with a single, final sentence that lands with finality (e.g. "Do it." "Now." "Go." "Start."). The pep must never sound cut off.
- Use blank lines for pauses before the final command. Put the final command on its own line after blank lines for emphasis.
- NO exclamation points. The ending should feel calm, slow, and commanding.
- For long-form: Use call-and-response pattern in ending. Examples: "Say it one last time." (blank line) "I do hard things." OR "Now move."
- Do not end with a trailing suggestion, a question, or "and..." â€” always end with a clear, complete closing statement.

OPTIONAL DELIVERY CUES (for consistent pacing):
- You MAY add optional cues on their own line to control pause length. These are stripped for TTS and reading view.
- [PAUSE 0.8] = 0.8 second silence after the previous line(s). Use decimals: 0.5, 1.0, 1.2, etc. (max ~5s).
- [PAUSE 4] or [PAUSE 5] = use after breathing/body instructions (e.g. "Breathe in." then [PAUSE 4] then "Breathe out.") so the listener has real time to follow. For easy/calm tone with breathing exercises, this is important.
- [BEAT] = short beat pause (~0.3s). Use after a key word or before a punchline.
- For 120s/180s: write for SLOW, deliberate delivery. Use 2-3 blank lines between sections. When including breathing or body steps, add [PAUSE 4] after each step.
- Cues are optional; blank lines still create default pauses. Use cues when you want precise, consistent pacing.

OUTPUT FORMAT (CRITICAL):
- Write in BEATS: short lines, intentional breaks. No long paragraphs.
- Use BLANK LINES between major sections (2-3 blank lines for silence anchors).
- PRESERVE BLANK LINES ALL THE WAY INTO TTS INPUT: they become real pauses. Do NOT trim or collapse them.
- Do NOT collapse whitespace. Do NOT collapse multiple newlines (each blank line is intentional).
- Do NOT trim internal whitespace. Only the raw script is neededâ€”blank lines stay as-is.
- Do NOT write in long paragraphs. Break every thought across short lines.
- Break thoughts across multiple lines for emphasis. Use repetition for emphasis.
- Return ONLY the script text. No quotes around the text, no formatting markers.
- The tone must be clearly "${tone}" - follow the tone-specific rules above.
- Target ${wordTargets.min}-${wordTargets.max} words.
- For long-form (${finalTargetSeconds}s+), maintain this beat structure throughout - do NOT compress or summarize.
- For Flow 300s: Ensure 700-850 words. Write SLOWLY and HEAVILY with real pauses.
- All content must be completely original. Do not copy or echo any existing speeches or famous lines.
- Guardrails: no harmful instructions, no profanity. Keep content motivational and safe.`;
}

app.post("/pep", async (req, res) => {
  const clientIP = getClientIP(req);
  
  try {
    // Check and reset daily counts if needed
    checkAndResetDailyCounts();
    
    // Check rate limit per IP
    if (!checkRateLimit(clientIP)) {
      console.log(`[INFO] Rate limit exceeded for IP: ${clientIP}`);
      return res.status(429).json({ error: "Rate limit exceeded. Maximum 20 requests per hour per IP." });
    }
    
    const { userText, tier = "free", tone = "direct", targetSeconds, voiceProfileId = null, outcome = null, obstacle = null, intents = [], intentOther = null, profileSummary = null, stream: wantStream = false } = req.body;

    // Validate input
    if (!userText || typeof userText !== "string" || userText.trim().length === 0) {
      console.log("[FAIL] PEP request failed: Missing or empty userText");
      return res.status(400).json({ error: "userText must be a non-empty string" });
    }

    const maxUserTextChars = tier === "free" ? 500 : 1500;
    if (userText.length > maxUserTextChars) {
      console.log(`[INFO] PEP request failed: userText too long (${userText.length} chars, max ${maxUserTextChars})`);
      return res.status(400).json({ error: `userText too long (max ${maxUserTextChars} characters)` });
    }

    const validIntents = Array.isArray(intents) ? intents.filter((i) => typeof i === "string" && i.trim().length > 0) : [];
    const intentOtherStr = typeof intentOther === "string" && intentOther.trim().length > 0 ? intentOther.trim() : null;
    const profileSummaryStr = typeof profileSummary === "string" && profileSummary.trim().length > 0 ? profileSummary.trim() : null;

    if (!["free", "pro", "flow"].includes(tier)) {
      return res.status(400).json({ error: "Invalid tier. Must be 'free', 'pro', or 'flow'" });
    }

    if (!["easy", "steady", "direct", "blunt", "no_excuses"].includes(tone)) {
      return res.status(400).json({ error: "Invalid tone. Must be 'easy', 'steady', 'direct', 'blunt', or 'no_excuses'" });
    }

    // Map targetSeconds to WORD targets (~2.76 words/sec observed pacing)
    const wordCountMap = {
      30: { min: 75, max: 95 },
      60: { min: 150, max: 180 },
      90: { min: 230, max: 260 },
      120: { min: 300, max: 340 },
      180: { min: 460, max: 520 },
      300: { min: 800, max: 880 },
    };

    // Default targetSeconds based on tier if not provided; coerce number (client may send string)
    let finalTargetSeconds =
      typeof targetSeconds === "number" && Number.isFinite(targetSeconds)
        ? targetSeconds
        : typeof targetSeconds === "string"
          ? parseInt(targetSeconds, 10)
          : undefined;
    if (!finalTargetSeconds || finalTargetSeconds <= 0 || isNaN(finalTargetSeconds)) {
      finalTargetSeconds = tier === "flow" ? 90 : tier === "pro" ? 60 : 30;
    }

    // Enforce tier-based max limits
    const tierMaxSeconds = tier === "flow" ? 300 : tier === "pro" ? 90 : 30;
    if (finalTargetSeconds > tierMaxSeconds) {
      console.log(`[INFO] PEP request failed: targetSeconds ${finalTargetSeconds} exceeds tier max ${tierMaxSeconds}`);
      return res.status(400).json({ error: `targetSeconds cannot exceed ${tierMaxSeconds} seconds for ${tier} tier` });
    }

    // Validate targetSeconds is a valid option
    if (!wordCountMap[finalTargetSeconds]) {
      console.log(`[INFO] PEP request failed: Invalid targetSeconds ${finalTargetSeconds}`);
      return res.status(400).json({ error: "Invalid targetSeconds. Must be one of: 30, 60, 90, 120, 180, 300" });
    }
    
    // Get word count targets
    const wordTargets = wordCountMap[finalTargetSeconds];
    const isLongForm = finalTargetSeconds >= 120;
    const isDirectOrNoExcuses = tone === "direct" || tone === "no_excuses";
    const needsSpeechBlocks = isDirectOrNoExcuses && finalTargetSeconds >= 60;

    // Map voiceProfileId to OpenAI voice
    const VOICE_PROFILE_MAP = {
      coach_m: "alloy",
      coach_f: "nova",
      calm_m: "onyx",
      calm_f: "sage",
    };
    
    let openAIVoice = "alloy"; // Default for free users
    if (voiceProfileId) {
      if (!VOICE_PROFILE_MAP[voiceProfileId]) {
        console.log(`[INFO] PEP request failed: Invalid voiceProfileId ${voiceProfileId}`);
        return res.status(400).json({ error: `Invalid voiceProfileId. Must be one of: ${Object.keys(VOICE_PROFILE_MAP).join(", ")}` });
      }
      openAIVoice = VOICE_PROFILE_MAP[voiceProfileId];
    }

    // Estimate max characters from word count (average 5 chars per word + spaces)
    const estimatedMaxChars = wordTargets.max * 6; // Conservative estimate

    // Safety evaluation - check BEFORE generating pep talk (skip LLM for 30s to speed up; keyword check only)
    const isShortPep = finalTargetSeconds <= 30;
    console.log(`[INFO] Evaluating safety for: ${userText.substring(0, 50)}...`);
    const safetyCheck = await evaluateRequestSafety(userText.trim(), isShortPep);
    
    if (!safetyCheck.isSafe) {
      console.log(`[INFO] Unsafe request detected: ${userText.substring(0, 50)}... (reason: ${safetyCheck.reason})`);
      const refusalText = await generateRefusalResponse(userText.trim(), tone, estimatedMaxChars);
      
      console.log(`[INFO] Refusal generated: ${refusalText.length} chars`);
      
      // Return refusal WITHOUT generating TTS audio
      return res.json({
        scriptText: refusalText,
        audioBase64: null,
      });
    }

    // Check daily caps (only for free and pro, not flow)
    if (tier === "free" || tier === "pro") {
      const maxFree = parseInt(process.env.MAX_FREE_DAILY_REQUESTS || "200", 10);
      const maxPro = parseInt(process.env.MAX_PRO_DAILY_REQUESTS || "200", 10);
      
      if (tier === "free" && dailyCounts.free >= maxFree) {
        console.log(`[INFO] Daily free cap reached: ${dailyCounts.free}/${maxFree}`);
        return res.status(429).json({ error: "Daily capacity reached" });
      }
      
      if (tier === "pro" && dailyCounts.pro >= maxPro) {
        console.log(`[INFO] Daily pro cap reached: ${dailyCounts.pro}/${maxPro}`);
        return res.status(429).json({ error: "Daily capacity reached" });
      }
    }


    // Tiered prompts to reduce tokens and LLM latency: short (30s), medium (60s/90s), full or condensed long (120s/180s)
    const isMediumPep = finalTargetSeconds === 60 || finalTargetSeconds === 90;
    const useCondensedLongForm = isLongForm; // 120s and 180s get condensed full prompt (same content, fewer words)
    let systemPrompt;
    if (isShortPep) {
      const shortClosings = {
        easy: "End with a softer, encouraging close.",
        steady: "End with clear but gentle direction.",
        direct: "End with clear action.",
        blunt: "End with direct command.",
        no_excuses: "End with a slow, spaced call-to-action.",
      };
      systemPrompt = `You are Pep, a motivational coach. Write a 30-second pep: ${wordTargets.min}-${wordTargets.max} words.
Tone: ${tone}. ${shortClosings[tone] || shortClosings.direct}
Use short, natural sentences. Keep the flow tightâ€”avoid long pauses or big gaps between ideas. Do NOT add extra blank lines just for drama.
No exclamation points. Last line MUST be one clear closing sentence (e.g. "Do it." "Now." "Go.")â€”never end mid-thought or with a question.
${outcome ? `Desired outcome: ${outcome}. ` : ""}${obstacle ? `Obstacle: ${obstacle}. ` : ""}
Fully original. No famous quotes or copied phrases.`;
    } else if (isMediumPep) {
      const mediumTone = {
        easy: { opening: "Start with validation and understanding.", closing: "End with a softer, encouraging close." },
        steady: { opening: "Start with calm acknowledgment.", closing: "End with clear but gentle direction." },
        direct: { opening: "Start directly with the situation.", closing: "End with clear action." },
        blunt: { opening: "Start by naming the avoidance.", closing: "End with direct command." },
        no_excuses: { opening: "Start with firm confrontation; name what they're avoiding.", closing: "End with slow, spaced call-to-action; final line on its own after blank lines." },
      };
      const tr = mediumTone[tone] || mediumTone.direct;
      let ctx = "";
      if (profileSummaryStr) ctx += `\nPersonalization: ${profileSummaryStr}`;
      if (validIntents.length) ctx += `\nIntents: ${validIntents.join(", ")}.${intentOtherStr ? ` Other: ${intentOtherStr}` : ""}`;
      if (outcome) ctx += `\nOutcome: ${outcome}`;
      if (obstacle) ctx += `\nObstacle: ${obstacle}`;
      const speechBlocksNote = needsSpeechBlocks
        ? "\nInclude: 1 call-and-response block, 1 identity chant (phrase repeated 2-4x), 1 countdown or stepwise ramp, and 3+ silence anchors (blank lines around key lines). Short lines only."
        : "";
      systemPrompt = `You are Pep, a motivational coach. Write a pep: ${wordTargets.min}-${wordTargets.max} words (~${finalTargetSeconds} seconds when spoken).${ctx}

Tone: ${tone}. ${tr.opening} ${tr.closing}
STRUCTURE: 1. Name the resistance 2. Reframe 3. Clear next step or participation 4. Strong close (one clear final sentence).${speechBlocksNote}

Use short lines. Blank lines create pauses. No exclamation points. Last line MUST be a complete closing sentenceâ€”never end mid-thought. Fully original; no famous quotes.`;
    } else {
      systemPrompt = getToneSpecificPrompt(tone, wordTargets, outcome, obstacle, isLongForm, validIntents, intentOtherStr, profileSummaryStr, useCondensedLongForm, finalTargetSeconds, needsSpeechBlocks);
    }

    const scriptGenStart = Date.now();
    console.log("[SCRIPT] Generating pep talk: tier=" + tier + ", tone=" + tone + ", targetSeconds=" + finalTargetSeconds + ", wordTarget=" + wordTargets.min + "-" + wordTargets.max + ", isLongForm=" + isLongForm);

    // Generate pep talk script using OpenAI (tighter tokens + lower temp for 30s = faster)
    const estimatedMaxTokens = isShortPep
      ? 100
      : Math.ceil(wordTargets.max * 0.75 * 1.2);
    const scriptTemperature = isShortPep ? 0.5 : 0.7;
    
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `Create a pep talk for: ${userText.trim()}${outcome ? `\n\nDesired outcome: ${outcome}` : ''}${obstacle ? `\n\nReal obstacle: ${obstacle}` : ''}`,
        },
      ],
      max_tokens: estimatedMaxTokens,
      temperature: scriptTemperature,
    });

    let scriptText = completion.choices[0]?.message?.content?.trim();

    if (!scriptText) {
      throw new Error("Failed to generate script text");
    }

    // Clean up the script: remove quotes if wrapped; trim only leading/trailing.
    scriptText = scriptText.replace(/^["']|["']$/g, '').trim();

    const minWordsRequired = wordTargets.min;
    // Only expand when clearly too short (below 85% of min). Within 15% of min = no expansion.
    const minThreshold = Math.floor(minWordsRequired * 0.85);
    const maxWordsAllowed = Math.floor(wordTargets.max * 1.1);

    let finalScript = scriptText;
    let currentWordCount = scriptText.split(/\s+/).filter(word => word.length > 0).length;
    const initialWordCount = currentWordCount;
    let expandedWordCount = null;
    console.log("[SCRIPT] Initial word count: " + initialWordCount + " (target: " + wordTargets.min + "-" + wordTargets.max + ", max allowed: " + maxWordsAllowed + ")");

    const skipExpansion = finalTargetSeconds <= 60;
    if (currentWordCount < minThreshold && !skipExpansion) {
      console.log("[SCRIPT] Under minimum (" + currentWordCount + " < " + minThreshold + "), running expansion pass...");
      finalScript = await expandScriptToTarget(client, finalScript, wordTargets, userText, outcome, obstacle);
      currentWordCount = finalScript.split(/\s+/).filter(word => word.length > 0).length;
      expandedWordCount = currentWordCount;
      console.log("[SCRIPT] Expanded word count: " + currentWordCount + " (target: " + minWordsRequired + "-" + wordTargets.max + ")");
    }

    const scriptGenDuration = Date.now() - scriptGenStart;
    console.log("[SCRIPT] Total script generation duration: " + scriptGenDuration + "ms (initial: " + initialWordCount + (expandedWordCount != null ? ", expanded: " + expandedWordCount : "") + ")");

    // Only trim if exceeds max by >10% (never trim long-form unless over max*1.1)
    if (currentWordCount > maxWordsAllowed) {
      console.log("[SCRIPT] Script exceeds max word count (" + currentWordCount + " > " + maxWordsAllowed + "), trimming...");
      const targetWords = wordTargets.max;
      let reconstructed = '';
      let currentWordIndex = 0;
      const lines = finalScript.split('\n');
      
      for (const line of lines) {
        // Preserve blank lines (they create pauses in TTS)
        if (line.trim().length === 0) {
          reconstructed += '\n';
          continue;
        }
        
        const lineWords = line.trim().split(/\s+/).filter(w => w.length > 0);
        if (currentWordIndex + lineWords.length <= targetWords) {
          reconstructed += line + '\n';
          currentWordIndex += lineWords.length;
        } else {
          // Add partial line only if we can end at a sentence boundary (avoid abrupt cutoff)
          const remainingWords = targetWords - currentWordIndex;
          if (remainingWords > 0 && lineWords.length > 0) {
            const partialLine = lineWords.slice(0, remainingWords).join(' ');
            const lastPeriod = Math.max(partialLine.lastIndexOf('.'), partialLine.lastIndexOf('!'), partialLine.lastIndexOf('?'));
            if (lastPeriod > partialLine.length * 0.5) {
              reconstructed += partialLine.substring(0, lastPeriod + 1).trim();
            }
            // Else: do not add fragment; stop at previous line so the pep ends on a complete sentence
          }
          break;
        }
      }
      
      // Preserve trailing blank lines but limit excessive whitespace (max 3 consecutive blank lines)
      finalScript = reconstructed.replace(/\n{4,}/g, '\n\n\n').replace(/^\s+|\s+$/g, '');
      currentWordCount = finalScript.split(/\s+/).filter(word => word.length > 0).length;
      console.log("[SCRIPT] Trimmed script to " + currentWordCount + " words (ending on complete sentence)");
    }

    // For short peps (â‰¤30s), collapse multiple blank lines to avoid overly long pauses in TTS.
    if (isShortPep) {
      finalScript = finalScript.replace(/\n{2,}/g, '\n');
    }

    const finalWordCount = finalScript.split(/\s+/).filter(word => word.length > 0).length;
    const blankLineCount = (finalScript.match(/\n\s*\n/g) || []).length;
    console.log(`[INFO] Script generated: ${finalWordCount} words (target: ${wordTargets.min}-${wordTargets.max}), ${finalScript.length} chars, tier: ${tier}, targetSeconds: ${finalTargetSeconds}`);

    // Clean display text (no delivery cues) for reading view and client display, and ensure it ends on a full sentence.
    // Use this same text as the basis for TTS so the audio never ends on a dangling fragment (e.g. "three" with no closing sentence).
    const displayText = ensureEndsOnSentence(stripCuesToDisplay(finalScript));
    const scriptForTts = stripCuesForTts(displayText);

    // Segment pause (default) by tone for chunked playback. Easy/steady get longer pauses for breathing/repeat-after-me.
    const segmentPauseByTone = { easy: 500, steady: 400, direct: 350, blunt: 350, no_excuses: 450 };
    const segmentPauseMs = segmentPauseByTone[tone] ?? 450;
    const defaultPauseSeconds = segmentPauseMs / 1000;
    const ttsSpeedPep = (finalTargetSeconds >= 120 || tone === "easy" || tone === "steady" || voiceProfileId === "calm_f") ? 0.88 : 1.0;

    // Parse script into segments (by cues and/or blank lines); cues control per-segment pause.
    // For short peps (â‰¤30s), skip chunked TTS entirely to keep generation fast and avoid extra pauses.
    const allowChunkedTts = !isShortPep;
    const segmentsWithPauses = allowChunkedTts ? parseScriptWithCues(finalScript, defaultPauseSeconds) : [];
    const useChunkedTts = allowChunkedTts && segmentsWithPauses.length > 1;

    // ----- Diagnostic logging (custom pep duration diagnosis)
    console.log("[DIAG] initialScriptWordCount=" + initialWordCount);
    console.log("[DIAG] expandedScriptWordCount=" + (expandedWordCount != null ? expandedWordCount : "N/A"));
    console.log("[DIAG] finalScriptWordCount=" + finalWordCount);
    console.log("[DIAG] finalScriptCharCount=" + finalScript.length);
    const ttsInputChars = useChunkedTts
      ? segmentsWithPauses.reduce((sum, s) => sum + (s.text ? s.text.length : 0), 0)
      : scriptForTts.length;
    console.log("[DIAG] ttsInputSource=" + (useChunkedTts ? "chunked (" + segmentsWithPauses.length + " segments from finalScript)" : "full (scriptForTts from finalScript->displayText->stripCuesForTts)"));
    console.log("[DIAG] TTS uses exact finalScript-derived text: yes (displayText=ensureEndsOnSentence(stripCuesToDisplay(finalScript)); scriptForTts=stripCuesForTts(displayText); chunks=parseScriptWithCues(finalScript))");
    console.log("[DIAG] ttsInputCharCount=" + ttsInputChars);
    if (useChunkedTts && segmentsWithPauses.length > 0) {
      segmentsWithPauses.forEach((seg, i) => {
        const w = (seg.text || "").trim().split(/\s+/).filter(Boolean).length;
        const c = (seg.text || "").length;
        console.log("[DIAG] chunk " + i + ": words=" + w + " chars=" + c);
      });
      const totalChunkWords = segmentsWithPauses.reduce((sum, s) => sum + (s.text || "").trim().split(/\s+/).filter(Boolean).length, 0);
      console.log("[DIAG] chunked total: " + segmentsWithPauses.length + " segments, totalWords=" + totalChunkWords + " totalChars=" + ttsInputChars);
    }

    // ----- Streaming path: send script then TTS segments one-by-one so client can start playback on first chunk
    if (wantStream) {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no"); // nginx
      if (res.flushHeaders) res.flushHeaders();
      const sendLine = (obj) => res.write(JSON.stringify(obj) + "\n");
      sendLine({ type: "script", scriptText: displayText, wordCount: finalWordCount, segmentPauseMs });
      try {
        if (useChunkedTts && segmentsWithPauses.length > 0) {
          for (let i = 0; i < segmentsWithPauses.length; i++) {
            const { text, pauseAfterSeconds } = segmentsWithPauses[i];
            if (!text) continue;
            const segMp3 = await client.audio.speech.create({ model: "gpt-4o-mini-tts", voice: openAIVoice, input: text, speed: ttsSpeedPep });
            let segBuf = Buffer.from(await segMp3.arrayBuffer());
            if (finalTargetSeconds > 30) segBuf = await normalizeAudioToLufs(segBuf);
            sendLine({ type: "segment", index: i, audioBase64: segBuf.toString("base64"), pauseAfterSeconds });
          }
        } else {
          const fullMp3 = await client.audio.speech.create({ model: "gpt-4o-mini-tts", voice: openAIVoice, input: scriptForTts, speed: ttsSpeedPep });
          let fullBuf = Buffer.from(await fullMp3.arrayBuffer());
          if (finalTargetSeconds > 30) fullBuf = await normalizeAudioToLufs(fullBuf);
          sendLine({ type: "segment", index: 0, audioBase64: fullBuf.toString("base64"), pauseAfterSeconds: 0 });
        }
        if (tier === "free") dailyCounts.free++;
        else if (tier === "pro") dailyCounts.pro++;
        logUsage(tier, displayText.length, clientIP);
        console.log("[SUMMARY] targetSeconds=" + finalTargetSeconds + " | finalWords=" + finalWordCount + " | audioDurationSec=N/A (streaming)");
        if (useChunkedTts && segmentsWithPauses.length > 0) {
          console.log("[DIAG] chunked TTS: all " + segmentsWithPauses.length + " segments synthesized and sent");
        }
        sendLine({ type: "done" });
      } catch (streamErr) {
        console.error("[FAIL] PEP stream error:", streamErr.message);
        sendLine({ type: "error", error: streamErr.message });
      }
      res.end();
      return;
    }

    // ----- Non-streaming path: full TTS, save to temp file, return audioUrl + timing logs
    const totalAudioStart = Date.now();
    console.log("[AUDIO] TTS request start");
    const ttsStart = Date.now();

    const fullMp3 = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: openAIVoice,
      input: scriptForTts,
      speed: ttsSpeedPep,
    });
    let fullBuf = Buffer.from(await fullMp3.arrayBuffer());
    const ttsEnd = Date.now();
    console.log("[AUDIO] TTS request end (" + (ttsEnd - ttsStart) + "ms)");

    if (finalTargetSeconds > 30) fullBuf = await normalizeAudioToLufs(fullBuf);
    fullBuf = await reencodeMp3ToSpeechBitrate(fullBuf);

    let audioSegments = null;
    let segmentPauseDurations = null;
    if (useChunkedTts) {
      console.log("Generating chunked TTS: " + segmentsWithPauses.length + " segments");
      const base64s = [];
      const pauseDurations = [];
      for (let i = 0; i < segmentsWithPauses.length; i++) {
        const { text, pauseAfterSeconds } = segmentsWithPauses[i];
        if (!text) continue;
        const segMp3 = await client.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: openAIVoice,
          input: text,
          speed: ttsSpeedPep,
        });
        let segBuf = Buffer.from(await segMp3.arrayBuffer());
        if (finalTargetSeconds > 30) segBuf = await normalizeAudioToLufs(segBuf);
        segBuf = await reencodeMp3ToSpeechBitrate(segBuf);
        base64s.push(segBuf.toString("base64"));
        pauseDurations.push(pauseAfterSeconds);
      }
      audioSegments = base64s;
      segmentPauseDurations = pauseDurations;
      console.log("[DIAG] chunked TTS: all " + segmentsWithPauses.length + " segments synthesized and included");
    }

    const audioDurationSec = await getMp3DurationSeconds(fullBuf);
    console.log("[DIAG] audioDurationSec=" + (audioDurationSec != null ? audioDurationSec.toFixed(2) : "N/A"));
    console.log("[SUMMARY] targetSeconds=" + finalTargetSeconds + " | finalWords=" + finalWordCount + " | audioDurationSec=" + (audioDurationSec != null ? audioDurationSec.toFixed(2) : "N/A"));

    console.log("[AUDIO] audio file save start");
    const saveStart = Date.now();
    const audioFileId = writeTempPepMp3(fullBuf);
    const audioUrl = getPepAudioUrl(req, audioFileId);
    const saveEnd = Date.now();
    console.log("[AUDIO] audio file save end (" + (saveEnd - saveStart) + "ms)");
    const totalDuration = Date.now() - totalAudioStart;
    console.log("[AUDIO] response sent (total audio generation: " + totalDuration + "ms)");

    if (tier === "free") {
      dailyCounts.free++;
    } else if (tier === "pro") {
      dailyCounts.pro++;
    }
    logUsage(tier, displayText.length, clientIP);

    const payload = {
      scriptText: displayText,
      audioUrl,
      wordCount: finalWordCount,
      ...(audioSegments && audioSegments.length > 0
        ? { audioSegments, segmentPauseMs, segmentPauseDurations }
        : {}),
    };
    res.json(payload);
  } catch (err) {
    console.error("[FAIL] PEP error:", err.message);
    
    // Provide helpful error messages
    if (err.message.includes("API key")) {
      return res.status(500).json({ error: "OpenAI API configuration error. Check API key." });
    }
    if (err.message.includes("rate limit")) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
    }
    if (err.message.includes("timeout")) {
      return res.status(504).json({ error: "Request timeout. Please try again." });
    }

    res.status(500).json({ error: "Pep talk generation failed: " + err.message });
  }
});

// Script-only endpoint: generate pep script without TTS
app.post("/pep-script", async (req, res) => {
  const clientIP = getClientIP(req);

  try {
    checkAndResetDailyCounts();

    if (!checkRateLimit(clientIP)) {
      console.log(`[INFO] Rate limit exceeded for IP: ${clientIP}`);
      return res.status(429).json({ error: "Rate limit exceeded. Maximum 20 requests per hour per IP." });
    }

    const {
      userText,
      tier = "free",
      tone = "direct",
      targetSeconds,
      voiceProfileId = null,
      outcome = null,
      obstacle = null,
      intents = [],
      intentOther = null,
      profileSummary = null,
    } = req.body;

    if (!userText || typeof userText !== "string" || userText.trim().length === 0) {
      console.log("[FAIL] PEP-SCRIPT request failed: Missing or empty userText");
      return res.status(400).json({ error: "userText must be a non-empty string" });
    }

    const maxUserTextChars = tier === "free" ? 500 : 1500;
    if (userText.length > maxUserTextChars) {
      console.log(`[INFO] PEP-SCRIPT request failed: userText too long (${userText.length} chars, max ${maxUserTextChars})`);
      return res.status(400).json({ error: `userText too long (max ${maxUserTextChars} characters)` });
    }

    const validIntents = Array.isArray(intents) ? intents.filter((i) => typeof i === "string" && i.trim().length > 0) : [];
    const intentOtherStr = typeof intentOther === "string" && intentOther.trim().length > 0 ? intentOther.trim() : null;
    const profileSummaryStr = typeof profileSummary === "string" && profileSummary.trim().length > 0 ? profileSummary.trim() : null;

    if (!["free", "pro", "flow"].includes(tier)) {
      return res.status(400).json({ error: "Invalid tier. Must be 'free', 'pro', or 'flow'" });
    }

    if (!["easy", "steady", "direct", "blunt", "no_excuses"].includes(tone)) {
      return res.status(400).json({ error: "Invalid tone. Must be 'easy', 'steady', 'direct', 'blunt', or 'no_excuses'" });
    }

    const wordCountMap = {
      30: { min: 75, max: 95 },
      60: { min: 150, max: 180 },
      90: { min: 230, max: 260 },
      120: { min: 300, max: 340 },
      180: { min: 460, max: 520 },
      300: { min: 800, max: 880 },
    };

    let finalTargetSeconds =
      typeof targetSeconds === "number" && Number.isFinite(targetSeconds)
        ? targetSeconds
        : typeof targetSeconds === "string"
          ? parseInt(targetSeconds, 10)
          : undefined;
    if (!finalTargetSeconds || finalTargetSeconds <= 0 || isNaN(finalTargetSeconds)) {
      finalTargetSeconds = tier === "flow" ? 90 : tier === "pro" ? 60 : 30;
    }

    const tierMaxSeconds = tier === "flow" ? 300 : tier === "pro" ? 90 : 30;
    if (finalTargetSeconds > tierMaxSeconds) {
      console.log(`[INFO] PEP-SCRIPT request failed: targetSeconds ${finalTargetSeconds} exceeds tier max ${tierMaxSeconds}`);
      return res.status(400).json({ error: `targetSeconds cannot exceed ${tierMaxSeconds} seconds for ${tier} tier` });
    }

    if (!wordCountMap[finalTargetSeconds]) {
      console.log(`[INFO] PEP-SCRIPT request failed: Invalid targetSeconds ${finalTargetSeconds}`);
      return res.status(400).json({ error: "Invalid targetSeconds. Must be one of: 30, 60, 90, 120, 180, 300" });
    }

    const wordTargets = wordCountMap[finalTargetSeconds];
    const isLongForm = finalTargetSeconds >= 120;
    const isDirectOrNoExcuses = tone === "direct" || tone === "no_excuses";
    const needsSpeechBlocks = isDirectOrNoExcuses && finalTargetSeconds >= 60;

    const VOICE_PROFILE_MAP = {
      coach_m: "alloy",
      coach_f: "nova",
      calm_m: "onyx",
      calm_f: "sage",
    };
    let openAIVoice = "alloy";
    if (voiceProfileId) {
      if (!VOICE_PROFILE_MAP[voiceProfileId]) {
        console.log(`[INFO] PEP-SCRIPT request failed: Invalid voiceProfileId ${voiceProfileId}`);
        return res.status(400).json({ error: `Invalid voiceProfileId. Must be one of: ${Object.keys(VOICE_PROFILE_MAP).join(", ")}` });
      }
      openAIVoice = VOICE_PROFILE_MAP[voiceProfileId];
    }

    const estimatedMaxChars = wordTargets.max * 6;
    const isShortPep = finalTargetSeconds <= 30;
    console.log(`[INFO] [SCRIPT] Evaluating safety for: ${userText.substring(0, 50)}...`);
    const safetyCheck = await evaluateRequestSafety(userText.trim(), isShortPep);
    if (!safetyCheck.isSafe) {
      console.log(`[INFO] [SCRIPT] Unsafe request detected: ${userText.substring(0, 50)}... (reason: ${safetyCheck.reason})`);
      const refusalText = await generateRefusalResponse(userText.trim(), tone, estimatedMaxChars);
      return res.status(200).json({
        requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        scriptText: refusalText,
        meta: { wordCount: refusalText.split(/\s+/).filter((w) => w.length > 0).length, estDurationSec: finalTargetSeconds },
      });
    }

    const isMediumPep = finalTargetSeconds === 60 || finalTargetSeconds === 90;
    const useCondensedLongForm = isLongForm;
    let systemPrompt;
    if (isShortPep) {
      const shortClosings = {
        easy: "End with a softer, encouraging close.",
        steady: "End with clear but gentle direction.",
        direct: "End with clear action.",
        blunt: "End with direct command.",
        no_excuses: "End with a slow, spaced call-to-action.",
      };
      systemPrompt = `You are Pep, a motivational coach. Write a 30-second pep: ${wordTargets.min}-${wordTargets.max} words.
Tone: ${tone}. ${shortClosings[tone] || shortClosings.direct}
Use short, natural sentences. Keep the flow tightâ€”avoid long pauses or big gaps between ideas. Do NOT add extra blank lines just for drama.
No exclamation points. Last line MUST be one clear closing sentence (e.g. "Do it." "Now." "Go.")â€”never end mid-thought or with a question.
${outcome ? `Desired outcome: ${outcome}. ` : ""}${obstacle ? `Obstacle: ${obstacle}. ` : ""}
Fully original. No famous quotes or copied phrases.`;
    } else if (isMediumPep) {
      const mediumTone = {
        easy: { opening: "Start with validation and understanding.", closing: "End with a softer, encouraging close." },
        steady: { opening: "Start with calm acknowledgment.", closing: "End with clear but gentle direction." },
        direct: { opening: "Start directly with the situation.", closing: "End with clear action." },
        blunt: { opening: "Start by naming the avoidance.", closing: "End with direct command." },
        no_excuses: { opening: "Start with firm confrontation; name what they're avoiding.", closing: "End with slow, spaced call-to-action; final line on its own after blank lines." },
      };
      const tr = mediumTone[tone] || mediumTone.direct;
      let ctx = "";
      if (profileSummaryStr) ctx += `\nPersonalization: ${profileSummaryStr}`;
      if (validIntents.length) ctx += `\nIntents: ${validIntents.join(", ")}.${intentOtherStr ? ` Other: ${intentOtherStr}` : ""}`;
      if (outcome) ctx += `\nOutcome: ${outcome}`;
      if (obstacle) ctx += `\nObstacle: ${obstacle}`;
      const speechBlocksNote = needsSpeechBlocks
        ? "\nInclude: 1 call-and-response block, 1 identity chant (phrase repeated 2-4x), 1 countdown or stepwise ramp, and 3+ silence anchors (blank lines around key lines). Short lines only."
        : "";
      systemPrompt = `You are Pep, a motivational coach. Write a pep: ${wordTargets.min}-${wordTargets.max} words (~${finalTargetSeconds} seconds when spoken).${ctx}

Tone: ${tone}. ${tr.opening} ${tr.closing}
STRUCTURE: 1. Name the resistance 2. Reframe 3. Clear next step or participation 4. Strong close (one clear final sentence).${speechBlocksNote}

Use short lines. Blank lines create pauses. No exclamation points. Last line MUST be a complete closing sentenceâ€”never end mid-thought. Fully original; no famous quotes.`;
    } else {
      systemPrompt = getToneSpecificPrompt(tone, wordTargets, outcome, obstacle, isLongForm, validIntents, intentOtherStr, profileSummaryStr, useCondensedLongForm, finalTargetSeconds, needsSpeechBlocks);
    }

    const scriptGenStart = Date.now();
        console.log(`[INFO] [SCRIPT] Generating pep script only: tier=${tier}, tone=${tone}, targetSeconds=${finalTargetSeconds}`);

    const estimatedMaxTokens = finalTargetSeconds <= 30 ? 100 : Math.ceil(wordTargets.max * 0.75 * 1.2);
    const scriptTemperature = finalTargetSeconds <= 30 ? 0.5 : 0.7;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Create a pep talk for: ${userText.trim()}${outcome ? `\n\nDesired outcome: ${outcome}` : ""}${obstacle ? `\n\nReal obstacle: ${obstacle}` : ""}`,
        },
      ],
      max_tokens: estimatedMaxTokens,
      temperature: scriptTemperature,
    });

    let scriptText = completion.choices[0]?.message?.content?.trim();
    if (!scriptText) {
      throw new Error("Failed to generate script text");
    }
    scriptText = scriptText.replace(/^["']|["']$/g, "").trim();

    const minWordsRequired = wordTargets.min;
    // Only expand when clearly too short (below 85% of min). Within 15% of min = no expansion.
    const minThreshold = Math.floor(minWordsRequired * 0.85);
    const maxWordsAllowed = Math.floor(wordTargets.max * 1.1);

    let finalScript = scriptText;
    let currentWordCount = scriptText.split(/\s+/).filter((word) => word.length > 0).length;
    const initialWordCount = currentWordCount;
    console.log("[SCRIPT] Initial word count: " + initialWordCount + " (target: " + wordTargets.min + "-" + wordTargets.max + ", max allowed: " + maxWordsAllowed + ")");

    const skipExpansion = finalTargetSeconds <= 60;
    if (currentWordCount < minThreshold && !skipExpansion) {
      console.log("[SCRIPT] Under minimum (" + currentWordCount + " < " + minThreshold + "), running expansion pass...");
      finalScript = await expandScriptToTarget(client, finalScript, wordTargets, userText, outcome, obstacle);
      currentWordCount = finalScript.split(/\s+/).filter((word) => word.length > 0).length;
      console.log("[SCRIPT] Expanded word count: " + currentWordCount + " (target: " + minWordsRequired + "-" + wordTargets.max + ")");
    }

    const scriptGenDuration = Date.now() - scriptGenStart;
    console.log("[SCRIPT] Total script generation duration: " + scriptGenDuration + "ms (initial: " + initialWordCount + (currentWordCount !== initialWordCount ? ", expanded: " + currentWordCount : "") + ")");

    if (currentWordCount > maxWordsAllowed) {
      console.log("[SCRIPT] Exceeds max word count (" + currentWordCount + " > " + maxWordsAllowed + "), trimming...");
      const targetWords = wordTargets.max;
      let reconstructed = "";
      let currentWordIndex = 0;
      const lines = finalScript.split("\n");

      for (const line of lines) {
        if (line.trim().length === 0) {
          reconstructed += "\n";
          continue;
        }
        const lineWords = line.trim().split(/\s+/).filter((w) => w.length > 0);
        if (currentWordIndex + lineWords.length <= targetWords) {
          reconstructed += line + "\n";
          currentWordIndex += lineWords.length;
        } else {
          const remainingWords = targetWords - currentWordIndex;
          if (remainingWords > 0 && lineWords.length > 0) {
            const partialLine = lineWords.slice(0, remainingWords).join(" ");
            const lastPeriod = Math.max(partialLine.lastIndexOf("."), partialLine.lastIndexOf("!"), partialLine.lastIndexOf("?"));
            if (lastPeriod > partialLine.length * 0.5) {
              reconstructed += partialLine.substring(0, lastPeriod + 1).trim();
            }
          }
          break;
        }
      }

      finalScript = reconstructed.replace(/\n{4,}/g, "\n\n\n").replace(/^\s+|\s+$/g, "");
      currentWordCount = finalScript.split(/\s+/).filter((word) => word.length > 0).length;
      console.log(`[INFO] [SCRIPT] Trimmed to ${currentWordCount} words`);
    }

    if (finalTargetSeconds <= 30) {
      finalScript = finalScript.replace(/\n{2,}/g, "\n");
    }

    const finalWordCount = finalScript.split(/\s+/).filter((word) => word.length > 0).length;
    const estDurationSec = Math.max(20, Math.round((finalWordCount / 150) * 60));
    console.log(`[INFO] [SCRIPT] Done: ${finalWordCount} words, estDurationSec=${estDurationSec}`);

    const displayText = ensureEndsOnSentence(stripCuesToDisplay(finalScript));
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    return res.json({
      requestId,
      scriptText: displayText,
      meta: {
        wordCount: finalWordCount,
        estDurationSec,
      },
    });
  } catch (err) {
    console.error("[FAIL] PEP-SCRIPT error:", err.message || err);
    return res.status(500).json({ error: "Pep script generation failed: " + (err.message || String(err)) });
  }
});

// Serve a temp pep audio file by id (then delete to free disk)
app.get("/pep-audio/:id", (req, res) => {
  const id = req.params.id || "";
  let decoded;
  try {
    decoded = decodeURIComponent(id);
  } catch (e) {
    return res.status(400).json({ error: "Invalid audio id" });
  }
  if (!/^pep_[a-z0-9_.]+\.mp3$/i.test(decoded)) {
    return res.status(400).json({ error: "Invalid audio id" });
  }
  const filePath = path.join(PEP_AUDIO_TEMP_DIR, decoded);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Audio not found or expired" });
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(filePath, (err) => {
    if (!err) {
      try { fs.unlinkSync(filePath); } catch (e) { console.warn("[pep-audio] cleanup failed:", e.message); }
    }
  });
});

// Audio-only endpoint: generate TTS from provided script
app.post("/pep-audio", async (req, res) => {
  const clientIP = getClientIP(req);

  try {
    checkAndResetDailyCounts();

    if (!checkRateLimit(clientIP)) {
      console.log(`[INFO] Rate limit exceeded for IP: ${clientIP}`);
      return res.status(429).json({ error: "Rate limit exceeded. Maximum 20 requests per hour per IP." });
    }

    const {
      requestId = null,
      scriptText,
      tier = "free",
      tone = "direct",
      targetSeconds,
      voiceProfileId = null,
    } = req.body;

    if (!scriptText || typeof scriptText !== "string" || scriptText.trim().length === 0) {
      console.log("[FAIL] PEP-AUDIO request failed: Missing or empty scriptText");
      return res.status(400).json({ error: "scriptText must be a non-empty string" });
    }

    if (!["free", "pro", "flow"].includes(tier)) {
      return res.status(400).json({ error: "Invalid tier. Must be 'free', 'pro', or 'flow'" });
    }
    if (!["easy", "steady", "direct", "blunt", "no_excuses"].includes(tone)) {
      return res.status(400).json({ error: "Invalid tone. Must be 'easy', 'steady', 'direct', 'blunt', or 'no_excuses'" });
    }

    let finalTargetSeconds =
      typeof targetSeconds === "number" && Number.isFinite(targetSeconds)
        ? targetSeconds
        : typeof targetSeconds === "string"
          ? parseInt(targetSeconds, 10)
          : undefined;
    if (!finalTargetSeconds || finalTargetSeconds <= 0 || isNaN(finalTargetSeconds)) {
      finalTargetSeconds = tier === "flow" ? 90 : tier === "pro" ? 60 : 30;
    }

    const VOICE_PROFILE_MAP = {
      coach_m: "alloy",
      coach_f: "nova",
      calm_m: "onyx",
      calm_f: "sage",
    };
    let openAIVoice = "alloy";
    if (voiceProfileId) {
      if (!VOICE_PROFILE_MAP[voiceProfileId]) {
        console.log(`[INFO] PEP-AUDIO request failed: Invalid voiceProfileId ${voiceProfileId}`);
        return res.status(400).json({ error: `Invalid voiceProfileId. Must be one of: ${Object.keys(VOICE_PROFILE_MAP).join(", ")}` });
      }
      openAIVoice = VOICE_PROFILE_MAP[voiceProfileId];
    }
    console.log("[AUDIO] TTS voice: profile=" + (voiceProfileId || "default") + " -> openAIVoice=" + openAIVoice);
    const totalStart = Date.now();
    console.log("[AUDIO] TTS request start");

    const ttsSpeed =
      finalTargetSeconds >= 120 || tone === "easy" || tone === "steady" || voiceProfileId === "calm_f"
        ? 0.88
        : 1.0;

    const scriptForTts = stripCuesForTts(scriptText);
    const pepAudioWordCount = scriptForTts.trim().split(/\s+/).filter(Boolean).length;
    const pepAudioTtsChars = scriptForTts.length;
    console.log("[DIAG] pep-audio scriptWordCount=" + pepAudioWordCount + " ttsInputCharCount=" + pepAudioTtsChars);

    const fullMp3 = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: openAIVoice,
      input: scriptForTts,
      speed: ttsSpeed,
    });
    let fullBuf = Buffer.from(await fullMp3.arrayBuffer());
    console.log("[AUDIO] TTS request end (" + (Date.now() - totalStart) + "ms)");
    if (finalTargetSeconds > 30) fullBuf = await normalizeAudioToLufs(fullBuf);
    fullBuf = await reencodeMp3ToSpeechBitrate(fullBuf);

    const pepAudioDurationSec = await getMp3DurationSeconds(fullBuf);
    console.log("[DIAG] pep-audio audioDurationSec=" + (pepAudioDurationSec != null ? pepAudioDurationSec.toFixed(2) : "N/A"));
    console.log("[SUMMARY] targetSeconds=" + finalTargetSeconds + " | finalWords=" + pepAudioWordCount + " | audioDurationSec=" + (pepAudioDurationSec != null ? pepAudioDurationSec.toFixed(2) : "N/A") + " (pep-audio)");

    console.log("[AUDIO] audio file save start");
    const saveStart = Date.now();
    const audioFileId = writeTempPepMp3(fullBuf);
    const audioUrl = getPepAudioUrl(req, audioFileId);
    console.log("[AUDIO] audio file save end (" + (Date.now() - saveStart) + "ms)");
    const totalDuration = Date.now() - totalStart;
    console.log("[AUDIO] response sent (total audio generation: " + totalDuration + "ms)");

    if (tier === "free") {
      dailyCounts.free++;
    } else if (tier === "pro") {
      dailyCounts.pro++;
    }
    logUsage(tier, scriptText.length, clientIP);

    const estDurationMs = Math.round(Math.max(20, (scriptText.split(/\s+/).filter((w) => w.length > 0).length / 150) * 60) * 1000);

    return res.json({
      requestId: requestId || (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)),
      audioUrl,
      durationMs: estDurationMs,
    });
  } catch (err) {
    console.error("[FAIL] PEP-AUDIO error:", err.message || err);
    return res.status(500).json({ error: "Pep audio generation failed: " + (err.message || String(err)) });
  }
});

// Keep /tts for debugging
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body;

    // Validate text exists and is a string
    if (!text || typeof text !== "string") {
      console.log("[FAIL] TTS request failed: Missing or invalid text");
      return res.status(400).json({ error: "Missing or invalid text" });
    }

    // Enforce max length (~90 seconds)
    if (text.length > 1400) {
      console.log(`[INFO] TTS request failed: Text too long (${text.length} chars, max 1400)`);
      return res.status(400).json({ error: "Text too long (max 1400 characters)" });
    }

    console.log(`[INFO] Generating TTS: ${text.length} chars, voice: ${voice}`);

    // Call OpenAI TTS API
    const mp3 = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voice,
      input: text,
    });

    // Convert ArrayBuffer to Buffer, normalize to -16 LUFS, then encode as base64
    let buffer = Buffer.from(await mp3.arrayBuffer());
    buffer = await normalizeAudioToLufs(buffer);
    const audioBase64 = buffer.toString("base64");

    console.log(`[INFO] TTS generated successfully: ${audioBase64.length} base64 chars`);

    res.json({ audioBase64: audioBase64 });
  } catch (err) {
    console.error("[FAIL] TTS error:", err.message);
    res.status(500).json({ error: "TTS generation failed" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API running on http://0.0.0.0:${PORT}`);
  console.log(`Accessible from network at http://<your-ip>:${PORT}`);
});
