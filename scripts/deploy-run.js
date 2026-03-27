const { execFileSync } = require("child_process");
const path = require("path");

const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
const script = path.join(__dirname, "deploy.sh");

try {
  execFileSync(bash, [script, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
  });
} catch (err) {
  process.exit(err.status || 1);
}
