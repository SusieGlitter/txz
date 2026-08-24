// 帧间跟踪验证：连续帧二维码缓慢运动 + 噪声，jsQR 路径（initPose）位姿是否帧间稳定
import * as THREE from 'three';
import { estimateQRPose } from '../src/utils/qrPose';

const iw = 1280, ih = 720;
const cx = iw / 2, cy = ih / 2;
const f = ih / 2 / Math.tan((45 * Math.PI) / 360);
const s = 5.0, half = s / 2;
const pts = [[-half, -half], [half, -half], [half, half], [-half, half]];

const rand = (() => { let seed = 123; return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; })();

const rotY = (a: number) => new THREE.Matrix4().makeRotationY(a);
const rotX = (a: number) => new THREE.Matrix4().makeRotationX(a);

let prevPose: { R: THREE.Matrix3; t: THREE.Vector3 } | null = null;
let prevPos: THREE.Vector3 | null = null;
let maxJump = 0, maxErr = 0, flips = 0;
let prevNormal: THREE.Vector3 | null = null;

for (let i = 0; i < 40; i++) {
  const ang = i * 0.02;
  // 二维码: 绕Y旋转 ang/2, 绕X固定 -35°, 位置缓慢绕圈
  const Rmat = new THREE.Matrix4().multiplyMatrices(rotX(-Math.PI * 0.35 / 1.5), rotY(ang * 0.5));
  const t = new THREE.Vector3(6 * Math.sin(ang), 0, -30 + 6 * Math.cos(ang));
  // 投影角点
  const img = pts.map(([px, py]) => {
    const wp = new THREE.Vector3(px, py, 0).applyMatrix4(Rmat).add(t);
    const u = f * wp.x / -wp.z + cx + (rand() - 0.5) * 2;
    const v = cy + (f * wp.y) / wp.z + (rand() - 0.5) * 2;
    return { x: u, y: v };
  });
  const pose = estimateQRPose(img, iw, ih, s, 45, prevPose ?? undefined);
  if (!pose) { console.log(`帧${i}: null`); continue; }
  // 位置误差
  const err = pose.position.distanceTo(t);
  maxErr = Math.max(maxErr, err);
  // 帧间跳变
  if (prevPos) {
    const jump = pose.position.distanceTo(prevPos);
    maxJump = Math.max(maxJump, jump);
  }
  // 法线翻转检测
  if (prevNormal && pose.normal.dot(prevNormal) < 0) flips++;
  prevNormal = pose.normal.clone();
  // 保存 initPose
  const m3 = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(pose.quaternion));
  prevPose = { R: m3, t: pose.position.clone() };
  prevPos = pose.position.clone();
}
console.log(`40 帧模拟: 最大位置误差=${maxErr.toFixed(2)}cm, 最大帧间跳变=${maxJump.toFixed(2)}cm, 法线翻转次数=${flips}`);
console.log('期望: 误差/跳变 < 2cm, 翻转 0 次（无镜像歧义跳变）');
