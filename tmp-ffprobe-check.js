const { spawn } = require('child_process');
const fs = require('fs');
const src = 'D:\\playlist-service\\videos\\33ljf [33ljf].mp4';
const target = 'D:\\playlist-service\\videos\\tmp-server-repro-output.mp4';
const args = ['-y','-i',src,'-ss','5','-t','10','-c:v','libx264','-c:a','aac','-movflags','+faststart',target];
console.log('ARGS', args.join(' '));
const child = spawn('ffmpeg', args, { windowsHide: true });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
child.stdout.on('data', chunk => { process.stdout.write(chunk.toString()); });
child.on('error', err => { console.log('ERROR_EVENT', err.message); process.exit(1); });
child.on('close', code => {
  console.log('CLOSE_CODE', code);
  console.log('STDERR_TAIL');
  console.log(stderr.slice(-2000));
  console.log('TARGET_EXISTS', fs.existsSync(target));
  if (fs.existsSync(target)) {
    console.log('SIZE', fs.statSync(target).size);
  }
});
