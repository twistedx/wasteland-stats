// Video compression via ffmpeg.
// Self-hosting clips for admin evidence; compress to H.264 720p @ CRF 28 to cut disk usage ~5–10x.
// Fails gracefully if ffmpeg isn't installed — original file is kept unchanged.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let ffmpegAvailable = null;
function hasFfmpeg() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    const r = spawnSync("ffmpeg", ["-version"], { timeout: 3000 });
    ffmpegAvailable = r.status === 0;
  } catch {
    ffmpegAvailable = false;
  }
  if (!ffmpegAvailable) console.warn("video-compress: ffmpeg not found; videos will be stored uncompressed.");
  return ffmpegAvailable;
}

// Transcode input → output. Returns { ok, originalSize, compressedSize, durationMs }.
// On failure, output is not created.
function compressVideo(inputPath, outputPath, { maxWidth = 1280, crf = 28, audioBitrate = "96k" } = {}) {
  return new Promise((resolve, reject) => {
    if (!hasFfmpeg()) return reject(new Error("ffmpeg not installed"));
    if (!fs.existsSync(inputPath)) return reject(new Error("input file missing"));

    const originalSize = fs.statSync(inputPath).size;
    const start = Date.now();

    const args = [
      "-y", // overwrite output
      "-i", inputPath,
      "-vcodec", "libx264",
      "-preset", "fast",
      "-crf", String(crf),
      "-vf", `scale='min(${maxWidth},iw)':-2`,
      "-movflags", "+faststart",
      "-acodec", "aac",
      "-b:a", audioBitrate,
      "-ac", "2",
      outputPath,
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", d => { stderr += d.toString(); });

    proc.on("error", err => {
      try { fs.unlinkSync(outputPath); } catch {}
      reject(err);
    });

    proc.on("close", code => {
      const durationMs = Date.now() - start;
      if (code !== 0) {
        try { fs.unlinkSync(outputPath); } catch {}
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      }
      if (!fs.existsSync(outputPath)) return reject(new Error("ffmpeg produced no output"));
      const compressedSize = fs.statSync(outputPath).size;
      resolve({ ok: true, originalSize, compressedSize, durationMs });
    });
  });
}

module.exports = { compressVideo, hasFfmpeg };
