// 调试：定位 qrPose.ts 中法线角差大的根源（DLT 初值 vs PnP 优化后）
import { estimateQRPose } from '../src/utils/qrPose';
import * as THREE from 'three';

function solveHomographyDLT(src: number[][], dst: number[][]): number[] | null {
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const [X, Y] = src[i];
    const [u, v] = dst[i];
    rows.push([-X, -Y, -1, 0, 0, 0, u * X, u * Y]);
    rhs.push(-u);
    rows.push([0, 0, 0, -X, -Y, -1, v * X, v * Y]);
    rhs.push(-v);
  }
  const n = 8;
  const N: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const c: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < rows.length; k++) s += rows[k][i] * rows[k][j];
      N[i][j] = s;
    }
    for (let k = 0; k < rows.length; k++) c[i] += rows[k][i] * rhs[k];
  }
  const M = N.map((row, i) => [...row, c[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const fct = M[r][col] / M[col][col];
      for (let c2 = col; c2 <= n; c2++) M[r][c2] -= fct * M[col][c2];
    }
  }
  const h = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c2 = r + 1; c2 < n; c2++) s -= M[r][c2] * h[c2];
    h[r] = s / M[r][r];
  }
  return [...h, 1];
}

const iw = 1280, ih = 720;
const cx = iw / 2, cy = ih / 2;
const f = ih / 2 / Math.tan((45 * Math.PI) / 360);
const s = 5.0, half = s / 2;

const a = Math.PI / 3;
const n3 = [0, Math.sin(a), Math.cos(a)];
const e1 = [1, 0, 0];
const e2 = [0, Math.cos(a), -Math.sin(a)]; // 正交于 n3 且 ⊥ e1：绕 X 旋转 60° 的 Y
// 校验: e2 ⊥ n3?
const d = e2[0]*n3[0]+e2[1]*n3[1]+e2[2]*n3[2];
console.log('e2·n3 =', d.toFixed(4));

const t3 = [0, 0, -30];
const TL = [t3[0]-half*e1[0]-half*e2[0], t3[1]-half*e1[1]-half*e2[1], t3[2]-half*e1[2]-half*e2[2]];
const TR = [t3[0]+half*e1[0]-half*e2[0], t3[1]+half*e1[1]-half*e2[1], t3[2]+half*e1[2]-half*e2[2]];
const BR = [t3[0]+half*e1[0]+half*e2[0], t3[1]+half*e1[1]+half*e2[1], t3[2]+half*e1[2]+half*e2[2]];
const BL = [t3[0]-half*e1[0]+half*e2[0], t3[1]-half*e1[1]+half*e2[1], t3[2]-half*e1[2]+half*e2[2]];

const proj = (p: number[]) => [f * p[0] / -p[2] + cx, cy + (f * p[1]) / p[2]];
const img = [TL, TR, BR, BL].map((p) => {
  const [u, v] = proj(p);
  return { x: u, y: v };
});
console.log('角点投影:', img.map(p => [Math.round(p.x), Math.round(p.y)]));

// 手算 DLT（复刻 estimateQRPose 前半段），打印初值法线
const src = [[-s/2,-s/2],[s/2,-s/2],[s/2,s/2],[-s/2,s/2]];
const dst = img.map(p => [p.x, p.y]);
const h = solveHomographyDLT(src, dst);
console.log('h =', h ? h.map(x => x.toFixed(4)) : 'null');

const g = h!.map((_, i) => {
  const idx = [0,1,2,3,4,5,6,7,8][i];
  if (idx < 6) return h![idx] / f - (idx % 2 === 0 ? cx * h![6] : cy * h![7]) / f;
  return h![idx];
});
// 用更明确的方式
const gg = [
  h![0]/f - cx*h![6]/f, h![1]/f - cx*h![7]/f, h![2]/f - cx*h![8]/f,
  h![3]/f - cy*h![6]/f, h![4]/f - cy*h![7]/f, h![5]/f - cy*h![8]/f,
  h![6], h![7], h![8],
];
const r1 = new THREE.Vector3(gg[0], gg[3], gg[6]);
const r2 = new THREE.Vector3(gg[1], gg[4], gg[7]);
const t = new THREE.Vector3(gg[2], gg[5], gg[8]);
const flip = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.y, -v.z);
let r1f = flip(r1), r2f = flip(r2), tf = flip(t);
const sc = (r1f.length() + r2f.length()) / 2;
r1f.divideScalar(sc); r2f.divideScalar(sc); tf.divideScalar(sc);
if (tf.z > 0) { r1f.multiplyScalar(-1); r2f.multiplyScalar(-1); tf.multiplyScalar(-1); }
const e1n = r1f.clone().normalize();
const e2n = r2f.clone().sub(e1n.clone().multiplyScalar(r2f.dot(e1n))).normalize();
let e3n = new THREE.Vector3().crossVectors(e1n, e2n).normalize();
const toCam = tf.clone().negate().normalize();
if (e3n.dot(toCam) < 0) e3n.multiplyScalar(-1);
console.log('DLT 初值: t=', tf.toArray().map(x=>x.toFixed(2)), '法线=', e3n.toArray().map(x=>x.toFixed(3)));
console.log('真实:     t=', t3, '法线=', n3);

// 完整 estimateQRPose
const pose = estimateQRPose(img, iw, ih, s, 45);
if (pose) {
  console.log('refine后: t=', pose.position.toArray().map(x=>x.toFixed(2)), '法线=', pose.normal.toArray().map(x=>x.toFixed(3)));
  const dot = pose.normal.dot(new THREE.Vector3(n3[0], n3[1], n3[2]));
  console.log('法线点积=', dot.toFixed(4), '角差=', (Math.acos(Math.max(-1, Math.min(1, dot)))*180/Math.PI).toFixed(2));
}
