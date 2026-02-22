const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const imgDir = path.join(__dirname, "..", "public", "img");
const files = fs.readdirSync(imgDir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));

async function compress() {
  for (const file of files) {
    const src = path.join(imgDir, file);
    const name = path.parse(file).name;
    const stat = fs.statSync(src);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

    // Skip the logo — already small
    if (file === "armatextlogo600x100.png") {
      console.log(`SKIP ${file} (${sizeMB} MB) — already small`);
      continue;
    }

    const outJpg = path.join(imgDir, name + ".jpg");

    // Resize large images to max 1920px wide, convert to optimized JPEG
    const img = sharp(src).resize({ width: 1920, withoutEnlargement: true });

    await img
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(outJpg + ".tmp");

    // Replace original with compressed JPEG
    const newStat = fs.statSync(outJpg + ".tmp");
    const newSizeMB = (newStat.size / 1024 / 1024).toFixed(2);
    const savings = (((stat.size - newStat.size) / stat.size) * 100).toFixed(0);

    // Remove the original PNG if it's different from the output
    if (path.extname(file).toLowerCase() === ".png") {
      fs.unlinkSync(src);
    }

    // Move temp to final
    if (fs.existsSync(outJpg) && outJpg !== src) {
      fs.unlinkSync(outJpg);
    }
    fs.renameSync(outJpg + ".tmp", outJpg);

    console.log(`${file} (${sizeMB} MB) → ${name}.jpg (${newSizeMB} MB) — ${savings}% smaller`);
  }
  console.log("\nDone!");
}

compress().catch(console.error);
