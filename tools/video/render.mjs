import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process"; import fs from "node:fs";
const dur = JSON.parse(fs.readFileSync("/home/claude/vid/durations.json")); const OUT="/home/claude/bgp2/web/assets/video";
const b = await chromium.launch();
for (const key of process.argv.slice(2)) {
  const p = await (await b.newContext({viewport:{width:1280,height:720}})).newPage();
  await p.goto(`file:///home/claude/vid/${key}.html`); await p.waitForTimeout(800);
  const tmp = `${OUT}/${key}.tmp.mp4`;
  const ff = spawn("ffmpeg", ["-y","-f","image2pipe","-framerate","30","-c:v","mjpeg","-i","-","-c:v","libx264","-preset","veryfast","-crf","24","-pix_fmt","yuv420p","-movflags","+faststart",tmp], {stdio:["pipe","ignore","ignore"]});
  const n = Math.round(dur[key]*30);
  for (let f=0; f<n; f++) {
    await p.evaluate((ms)=>document.getAnimations().forEach(a=>{a.pause();a.currentTime=ms}), f*1000/30);
    const buf = await p.screenshot({type:"jpeg",quality:92});
    if (!ff.stdin.write(buf)) await new Promise(r=>ff.stdin.once("drain",r));
  }
  ff.stdin.end(); const code = await new Promise(r=>ff.on("close",r));
  if (code===0) fs.renameSync(tmp, `${OUT}/${key}.mp4`);
  await p.evaluate((ms)=>document.getAnimations().forEach(a=>{a.pause();a.currentTime=ms}), 7000);
  await p.screenshot({path:`${OUT}/${key}.jpg`, type:"jpeg", quality:80});
  console.log(key, code, fs.statSync(`${OUT}/${key}.mp4`).size);
  await p.close();
}
await b.close();
