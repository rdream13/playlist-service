const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sourcePath = 'D:\\playlist-service\\videos\\Cum Loving Renee Rose Hops on Stepbros Dick for Role Play Fantasy Ride Filled with Loads of Fun [66abc8e0e825b].mp4';
const targetPath = 'D:\\playlist-service\\videos\\verify-trim-temp-path.mp4';
const parsedTarget = path.parse(targetPath);
const tempTargetPath = path.join(parsedTarget.dir, `${parsedTarget.name}.tmp-${process.pid}-${Date.now()}${parsedTarget.ext || '.mp4'}`);
console.log('SOURCE', sourcePath);
console.log('TEMP', tempTargetPath);
const args = ['-y', '-i', sourcePath, '-ss', '1500', '-t', '222', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', tempTargetPath];
const child = spawn('ffmpeg', args, { windowsHide: true });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.stdout.on('data', (chunk) => { process.stdout.write(chunk.toString()); });
child.on('error', (err) => {
  console.error('ERROR', err && err.message ? err.message : err);
  process.exit(1);
});
child.on('close', (code) => {
  console.log('EXIT', code);
  console.log('STDERR_TAIL', stderr.slice(-500));
  console.log('TEMP_EXISTS', fs.existsSync(tempTargetPath));
  if (fs.existsSync(tempTargetPath)) {
    fs.renameSync(tempTargetPath, targetPath);
    console.log('FINAL_EXISTS', fs.existsSync(targetPath));
    console.log('FINAL_SIZE', fs.statSync(targetPath).size);
  }
  process.exit(code === 0 ? 0 : 1);
});
