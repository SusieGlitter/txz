// 端到端验证 qrPose.ts 的 estimateQRPose（含 PnP 迭代优化）在大角度+噪声下的精度
import { estimateQRPose } from '../src/utils/qrPose';

const iw = 1280, ih = 720;
const cx = iw / 2, cy = ih / 2;
const f = ih / 2 / Math.tan((45 * Math.PI) / 360);
const s = 5.0, half = s / 2;

// 大角度场景：二维码绕世界 X 轴后仰 60°，法线朝 (0, sin60, cos60)
const a = Math.PI / 3;
const n3 = [0, Math.sin(a), Math.cos(a)];
const e1 = [1, 0, 0];
const norm = (v: number[]) => Math.sqrt(v.reduce((x, y) => x + y * y, 0));
const e2 = [
  n3[1] * e1[2] - n3[2] * e1[1],
  n3[2] * e1[0] - n3[0] * e1[2],
  n3[0] * e1[1] - n3[1] * e1[0],
].map((x) => x / norm([n3[1] * e1[2] - n3[2] * e1[1], n3[2] * e1[0] - n3[0] * e1[2], n3[0] * e1[1] - n3[1] * e1[0]]));

const t3 = [0, 0, -30];
const TL = [t3[0] - half * e1[0] - half * e2[0], t3[1] - half * e1[1] - half * e2[1], t3[2] - half * e1[2] - half * e2[2]];
const TR = [t3[0] + half * e1[0] - half * e2[0], t3[1] + half * e1[1] - half * e2[1], t3[2] + half * e1[2] - half * e2[2]];
const BR = [t3[0] + half * e1[0] + half * e2[0], t3[1] + half * e1[1] + half * e2[1], t3[2] + half * e1[2] + half * e2[2]];
const BL = [t3[0] - half * e1[0] + half * e2[0], t3[1] - half * e1[1] + half * e2[1], t3[2] - half * e1[2] + half * e2[2]];

const proj = (p: number[]) => [f * p[0] / -p[2] + cx, cy + (f * p[1]) / p[2]];

const rand = (() => {
  let seed = 42;
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
})();

for (const noise of [0, 1, 2]) {
  const img = [TL, TR, BR, BL].map((p) => {
    const [u, v] = proj(p);
    return { x: u + (rand() - 0.5) * 2 * noise, y: v + (rand() - 0.5) * 2 * noise };
  });
  const pose = estimateQRPose(img, iw, ih, s, 45);
  if (!pose) { console.log('noise', noise, ': pose null'); continue; }
  const dt = Math.sqrt((pose.position.x - t3[0]) ** 2 + (pose.position.y - t3[1]) ** 2 + (pose.position.z - t3[2]) ** 2);
  const dot = pose.normal.x * n3[0] + pose.normal.y * n3[1] + pose.normal.z * n3[2];
  const ang = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  console.log(`噪声±${noise}px: 位置误差=${dt.toFixed(2)}cm 法线角差=${ang.toFixed(2)}°`);
}
