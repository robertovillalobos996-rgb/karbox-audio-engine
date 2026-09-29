require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const AUDIO_SERVICE_TOKEN = String(
  process.env.AUDIO_SERVICE_TOKEN || ""
).trim();

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 30);

const TMP_DIR = path.join(__dirname, "tmp");
const OUTPUT_DIR = path.join(__dirname, "output");

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(
  cors({
    origin:
      ALLOWED_ORIGIN === "*"
        ? true
        : ALLOWED_ORIGIN.split(",").map((x) => x.trim()),
  })
);

app.use(express.json({ limit: "2mb" }));

const upload = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
  },
});

function safeDelete(filePath) {
  if (!filePath) return;

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("No se pudo eliminar temporal:", error.message);
  }
}

function cleanupUploadedFiles(req) {
  if (!req.files) return;

  Object.values(req.files)
    .flat()
    .forEach((file) => safeDelete(file.path));
}

function tokenMatches(received) {
  if (!AUDIO_SERVICE_TOKEN || !received) return false;

  const a = Buffer.from(AUDIO_SERVICE_TOKEN);
  const b = Buffer.from(received);

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  const customHeader = String(req.headers["x-audio-token"] || "").trim();

  const received = bearer || customHeader;

  if (!tokenMatches(received)) {
    return res.status(401).json({
      ok: false,
      error: "No autorizado",
    });
  }

  next();
}

function ffmpegAvailable() {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], (error) => {
      resolve(!error);
    });
  });
}

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ];

    const proc = spawn("ffprobe", args);

    let output = "";
    let errorOutput = "";

    proc.stdout.on("data", (data) => {
      output += data.toString();
    });

    proc.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `ffprobe falló: ${errorOutput || "sin información adicional"}`
          )
        );
      }

      const duration = Number.parseFloat(output.trim());

      if (!Number.isFinite(duration)) {
        return reject(new Error("No fue posible determinar la duración."));
      }

      resolve(duration);
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);

    let stderr = "";

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(stderr);

        return reject(
          new Error(`FFmpeg terminó con código ${code}`)
        );
      }

      resolve();
    });
  });
}

function num(value, fallback, min, max) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.min(max, Math.max(min, n));
}

async function renderAudio({
  voicePath,
  musicPath,
  watermarkPath,
  preview,
  options,
}) {
  const voiceDuration = await ffprobeDuration(voicePath);

  const introSeconds = num(options.introSeconds, 1.2, 0, 10);
  const outroSeconds = num(options.outroSeconds, 2, 0, 15);

  const voiceGain = num(options.voiceGain, 0, -20, 20);
  const musicGain = num(options.musicGain, -13, -40, 5);
  const watermarkGain = num(options.watermarkGain, -5, -30, 10);

  const watermarkEvery = num(
    options.watermarkEvery,
    7,
    4,
    30
  );

  const duckThreshold = num(
    options.duckThreshold,
    0.035,
    0.001,
    1
  );

  const duckRatio = num(
    options.duckRatio,
    10,
    1,
    30
  );

  const duckAttack = num(
    options.duckAttack,
    20,
    1,
    1000
  );

  const duckRelease = num(
    options.duckRelease,
    450,
    20,
    5000
  );

  const totalDuration =
    voiceDuration + introSeconds + outroSeconds;

  const outputName = `${crypto.randomUUID()}.mp3`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  const args = ["-y"];

  let voiceIndex = 0;
  let musicIndex = null;
  let watermarkIndex = null;

  args.push("-i", voicePath);

  if (musicPath) {
    musicIndex = 1;

    args.push(
      "-stream_loop",
      "-1",
      "-i",
      musicPath
    );
  }

  if (preview && watermarkPath) {
    watermarkIndex = musicPath ? 2 : 1;

    args.push("-i", watermarkPath);
  }

  const filters = [];

  const introMs = Math.round(introSeconds * 1000);

  filters.push(
    `[${voiceIndex}:a]` +
      `aresample=44100,` +
      `volume=${voiceGain}dB,` +
      `highpass=f=70,` +
      `acompressor=` +
      `threshold=-18dB:` +
      `ratio=3:` +
      `attack=15:` +
      `release=180:` +
      `makeup=2dB,` +
      `adelay=${introMs}|${introMs},` +
      `apad,` +
      `atrim=0:${totalDuration}` +
      `[voice]`
  );

  let baseLabel = "voice";

  if (musicPath) {
    filters.push(
      `[${musicIndex}:a]` +
        `aresample=44100,` +
        `volume=${musicGain}dB,` +
        `atrim=0:${totalDuration}` +
        `[music]`
    );

    filters.push(
      `[music][voice]` +
        `sidechaincompress=` +
        `threshold=${duckThreshold}:` +
        `ratio=${duckRatio}:` +
        `attack=${duckAttack}:` +
        `release=${duckRelease}` +
        `[ducked]`
    );

    filters.push(
      `[ducked][voice]` +
        `amix=inputs=2:` +
        `duration=longest:` +
        `normalize=0,` +
        `alimiter=limit=0.96` +
        `[base]`
    );

    baseLabel = "base";
  }

  let finalLabel = baseLabel;

  if (preview && watermarkPath) {
    const startAt = 2.5;

    const times = [];

    for (
      let t = startAt;
      t < totalDuration - 1;
      t += watermarkEvery
    ) {
      times.push(t);
    }

    if (times.length === 0) {
      times.push(Math.max(0.5, totalDuration / 2));
    }

    const splitLabels = times.map((_, i) => `wm${i}`);

    filters.push(
      `[${watermarkIndex}:a]` +
        `aresample=44100,` +
        `volume=${watermarkGain}dB,` +
        `asplit=${times.length}` +
        splitLabels.map((x) => `[${x}]`).join("")
    );

    const delayedLabels = [];

    times.forEach((seconds, index) => {
      const delayMs = Math.round(seconds * 1000);
      const delayed = `wmd${index}`;

      delayedLabels.push(delayed);

      filters.push(
        `[wm${index}]` +
          `adelay=${delayMs}|${delayMs},` +
          `apad,` +
          `atrim=0:${totalDuration}` +
          `[${delayed}]`
      );
    });

    filters.push(
      delayedLabels.map((x) => `[${x}]`).join("") +
        `amix=inputs=${delayedLabels.length}:` +
        `normalize=0:` +
        `duration=longest` +
        `[watermarks]`
    );

    filters.push(
      `[${baseLabel}][watermarks]` +
        `amix=inputs=2:` +
        `duration=first:` +
        `normalize=0,` +
        `alimiter=limit=0.96` +
        `[withwm]`
    );

    finalLabel = "withwm";
  }

  filters.push(
    `[${finalLabel}]` +
      `loudnorm=I=-16:LRA=9:TP=-1.5,` +
      `afade=t=in:st=0:d=0.15,` +
      `afade=t=out:` +
      `st=${Math.max(0, totalDuration - 1)}:` +
      `d=1` +
      `[final]`
  );

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[final]",
    "-vn",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-t",
    String(totalDuration),
    outputPath
  );

  await runFfmpeg(args);

  return {
    outputPath,
    outputName,
    duration: totalDuration,
  };
}

app.get("/", (req, res) => {
  res.json({
    service: "Karbox Audio Engine",
    status: "online",
  });
});

app.get("/health", async (req, res) => {
  const ffmpeg = await ffmpegAvailable();

  res.status(ffmpeg ? 200 : 503).json({
    ok: ffmpeg,
    service: "Karbox Audio Engine",
    ffmpeg,
    version: "1.0.0",
  });
});

const audioUpload = upload.fields([
  {
    name: "voice",
    maxCount: 1,
  },
  {
    name: "music",
    maxCount: 1,
  },
  {
    name: "watermark",
    maxCount: 1,
  },
]);

app.post(
  "/preview",
  requireAuth,
  audioUpload,
  async (req, res) => {
    let outputPath;

    try {
      const voice = req.files?.voice?.[0];
      const music = req.files?.music?.[0];
      const watermark = req.files?.watermark?.[0];

      if (!voice) {
        return res.status(400).json({
          ok: false,
          error: "Falta el archivo de voz.",
        });
      }

      if (!watermark) {
        return res.status(400).json({
          ok: false,
          error:
            "El preview requiere el audio de marca de agua.",
        });
      }

      const rendered = await renderAudio({
        voicePath: voice.path,
        musicPath: music?.path,
        watermarkPath: watermark.path,
        preview: true,
        options: req.body || {},
      });

      outputPath = rendered.outputPath;

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="karbox-preview-${Date.now()}.mp3"`
      );

      res.sendFile(outputPath, (error) => {
        cleanupUploadedFiles(req);
        safeDelete(outputPath);

        if (error) {
          console.error(
            "Error enviando preview:",
            error.message
          );
        }
      });
    } catch (error) {
      console.error(error);

      cleanupUploadedFiles(req);
      safeDelete(outputPath);

      res.status(500).json({
        ok: false,
        error: "No se pudo generar el preview.",
        detail: error.message,
      });
    }
  }
);

app.post(
  "/master",
  requireAuth,
  audioUpload,
  async (req, res) => {
    let outputPath;

    try {
      const voice = req.files?.voice?.[0];
      const music = req.files?.music?.[0];

      if (!voice) {
        return res.status(400).json({
          ok: false,
          error: "Falta el archivo de voz.",
        });
      }

      const rendered = await renderAudio({
        voicePath: voice.path,
        musicPath: music?.path,
        watermarkPath: null,
        preview: false,
        options: req.body || {},
      });

      outputPath = rendered.outputPath;

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="karbox-master-${Date.now()}.mp3"`
      );

      res.sendFile(outputPath, (error) => {
        cleanupUploadedFiles(req);
        safeDelete(outputPath);

        if (error) {
          console.error(
            "Error enviando master:",
            error.message
          );
        }
      });
    } catch (error) {
      console.error(error);

      cleanupUploadedFiles(req);
      safeDelete(outputPath);

      res.status(500).json({
        ok: false,
        error: "No se pudo generar el master.",
        detail: error.message,
      });
    }
  }
);

app.use((error, req, res, next) => {
  cleanupUploadedFiles(req);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      error: "Error al recibir archivos.",
      detail: error.message,
    });
  }

  console.error(error);

  res.status(500).json({
    ok: false,
    error: "Error interno del servicio.",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Karbox Audio Engine escuchando en puerto ${PORT}`
  );
});