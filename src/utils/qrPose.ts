import * as THREE from 'three';

export interface QRPose {
  valid: boolean;
  /**
   * 二维码中心在 Three.js 场景/相机坐标系中的位置（相机位于原点、朝向 -Z、
   * +Y 向上，单位与 qrSizeCm 一致，cm）。即与渲染相机的坐标系完全一致。
   */
  position: THREE.Vector3;
  /** 二维码平面的旋转（场景坐标系），平面局部 +Z = 平面法线（朝向相机） */
  quaternion: THREE.Quaternion;
  /** 二维码平面法线（指向相机，即远离桌面的方向） */
  normal: THREE.Vector3;
}

/**
 * 通过 4 组对应点求解单应矩阵 H（映射世界平面点 (X,Y,1) -> 图像点 (u,v,1)）。
 * 使用 DLT + 固定 h33=1 的最小二乘（法方程 + 高斯消元），避免完整 SVD。
 */
function solveHomographyDLT(
  src: number[][],
  dst: number[][]
): number[] | null {
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const [X, Y] = src[i];
    const [u, v] = dst[i];
    // 标准 DLT 两行（h33=1 时移到右侧）
    rows.push([-X, -Y, -1, 0, 0, 0, u * X, u * Y]);
    rhs.push(-u);
    rows.push([0, 0, 0, -X, -Y, -1, v * X, v * Y]);
    rhs.push(-v);
  }

  const n = 8;
  // 法方程：N = B^T B，c = B^T rhs
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

  // 增广矩阵 + 高斯消元（列主元）
  const M = N.map((row, i) => [...row, c[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c2 = col; c2 <= n; c2++) M[r][c2] -= f * M[col][c2];
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

/**
 * 高斯-牛顿迭代优化位姿（PnP refine）：以 DLT 结果为初值，最小化 4 角点重投影误差。
 * 大角度、角点带噪声时，直接 DLT 分解的位姿会明显漂移，迭代优化可大幅改善。
 */

/** 轴角 -> 旋转矩阵（Rodrigues） */
function rodrigues(wx: number, wy: number, wz: number): THREE.Matrix3 {
  const th = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (th < 1e-12) return new THREE.Matrix3().identity();
  const K = new THREE.Matrix3().set(0, -wz, wy, wz, 0, -wx, -wy, wx, 0);
  const a = Math.sin(th) / th;
  const b = (1 - Math.cos(th)) / (th * th);
  const K2 = new THREE.Matrix3().multiplyMatrices(K, K);
  // R = I + a*K + b*K2（逐元素，列主序）
  const ek = K.elements;
  const ek2 = K2.elements;
  const r = new THREE.Matrix3().elements;
  const Ie = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i++) r[i] = Ie[i] + a * ek[i] + b * ek2[i];
  return new THREE.Matrix3().set(
    r[0], r[3], r[6],
    r[1], r[4], r[7],
    r[2], r[5], r[8]
  );
}

/** 旋转矩阵 -> 轴角 */
function matrixToAxisAngle(R: THREE.Matrix3): { axis: THREE.Vector3; angle: number } {
  const e = R.elements; // 列主序: [R00,R10,R20, R01,R11,R21, R02,R12,R22]
  const trace = e[0] + e[4] + e[8];
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  if (angle < 1e-8) {
    return { axis: new THREE.Vector3(0, 1, 0), angle: 0 };
  }
  const s = 2 * Math.sin(angle);
  // w_x=(R21-R12)/s, w_y=(R02-R20)/s, w_z=(R10-R01)/s
  const axis = new THREE.Vector3(
    (e[5] - e[7]) / s,
    (e[6] - e[2]) / s,
    (e[1] - e[3]) / s
  ).normalize();
  return { axis, angle };
}

/** 由位姿参数 [wx,wy,wz,tx,ty,tz] 重投影 4 个角点，返回 8 维残差（u,v 各 4） */
function computeReprojResidual(
  params: Float64Array,
  objectPoints: number[][],
  imagePoints: number[][],
  f: number,
  cx: number,
  cy: number
): number[] {
  const R = rodrigues(params[0], params[1], params[2]);
  const e = R.elements;
  const out: number[] = [];
  for (let i = 0; i < objectPoints.length; i++) {
    const wx = objectPoints[i][0];
    const wy = objectPoints[i][1];
    // R * (wx, wy, 0) 列主序: col0=x*[e0,e1,e2] + col1=y*[e3,e4,e5]
    const camx = e[0] * wx + e[3] * wy + params[3];
    const camy = e[1] * wx + e[4] * wy + params[4];
    const camz = e[2] * wx + e[5] * wy + params[5];
    if (camz > -1e-6) {
      out.push(1e4, 1e4); // 相机后方，重罚
      continue;
    }
    out.push(f * camx / -camz + cx - imagePoints[i][0]);
    out.push(cy + (f * camy) / camz - imagePoints[i][1]);
  }
  return out;
}

/** 求解 6x6 线性方程组 A x = b */
function solve6(A: number[][], b: number[]): number[] | null {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 6; col++) {
    let pivot = col;
    for (let r = col + 1; r < 6; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < 6; r++) {
      if (r === col) continue;
      const fct = M[r][col] / M[col][col];
      for (let c = col; c <= 6; c++) M[r][c] -= fct * M[col][c];
    }
  }
  return M.map((row, i) => row[6] / row[i]);
}

/**
 * 以 DLT 得到的 R0/t0 为初值，用高斯-牛顿最小化重投影误差。
 * 返回优化后的 { R, t }；失败返回 null。
 */
function refinePosePnP(
  R0: THREE.Matrix3,
  t0: THREE.Vector3,
  objectPoints: number[][],
  imagePoints: number[][],
  f: number,
  cx: number,
  cy: number
): { R: THREE.Matrix3; t: THREE.Vector3 } | null {
  const { axis, angle } = matrixToAxisAngle(R0);
  const params = new Float64Array(6);
  params[0] = axis.x * angle;
  params[1] = axis.y * angle;
  params[2] = axis.z * angle;
  params[3] = t0.x;
  params[4] = t0.y;
  params[5] = t0.z;

  for (let iter = 0; iter < 15; iter++) {
    const r = computeReprojResidual(params, objectPoints, imagePoints, f, cx, cy);
    // 数值雅可比 6x8
    const J: number[][] = [];
    const eps = 1e-5;
    for (let k = 0; k < 6; k++) {
      const p2 = Float64Array.from(params);
      p2[k] += eps;
      const r2 = computeReprojResidual(p2, objectPoints, imagePoints, f, cx, cy);
      const col: number[] = [];
      for (let i = 0; i < r.length; i++) col.push((r2[i] - r[i]) / eps);
      J.push(col);
    }
    // 法方程 (J^T J + λI) Δ = -J^T r
    const JTJ: number[][] = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const JTr = new Array<number>(6).fill(0);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        let s = 0;
        for (let m = 0; m < r.length; m++) s += J[i][m] * J[j][m];
        JTJ[i][j] = s;
      }
      for (let m = 0; m < r.length; m++) JTr[i] += J[i][m] * r[m];
    }
    const lambda = 0.01;
    for (let i = 0; i < 6; i++) JTJ[i][i] += lambda;
    const delta = solve6(JTJ, JTr.map((v) => -v));
    if (!delta) return null;
    let maxStep = 0;
    for (let i = 0; i < 6; i++) maxStep = Math.max(maxStep, Math.abs(delta[i]));
    if (maxStep < 1e-8) break;
    for (let i = 0; i < 6; i++) params[i] += delta[i];
  }

  const R = rodrigues(params[0], params[1], params[2]);
  return {
    R,
    t: new THREE.Vector3(params[3], params[4], params[5]),
  };
}

/**
 * 由图像中二维码的 4 个角点估算二维码平面在相机坐标系中的位姿。
 * 焦距使用固定假设（fovYDeg），无需用户校准。
 *
 * @param corners 按顺序 TL, TR, BR, BL（顺时针，从左上开始）的图像像素坐标
 * @param imageWidth  视频帧原始宽度（像素）
 * @param imageHeight 视频帧原始高度（像素）
 * @param qrSizeCm    二维码物理边长（cm）
 * @param fovYDeg     相机垂直视场角（度）固定假设值
 */
export function estimateQRPose(
  corners: Array<{ x: number; y: number }>,
  imageWidth: number,
  imageHeight: number,
  qrSizeCm: number,
  fovYDeg: number
): QRPose | null {
  if (!corners || corners.length !== 4) return null;
  const s = qrSizeCm;
  const src = [
    [-s / 2, -s / 2],
    [s / 2, -s / 2],
    [s / 2, s / 2],
    [-s / 2, s / 2],
  ];
  const dst = corners.map((p) => [p.x, p.y]);
  const h = solveHomographyDLT(src, dst);
  if (!h) return null;

  // 相机内参（固定假设）：fx = fy = f，主点在画面中心
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const f = imageHeight / 2 / Math.tan((fovYDeg * Math.PI) / 360);

  // G = K^{-1} * H，行主序
  const g = [
    h[0] / f - (cx * h[6]) / f,
    h[1] / f - (cx * h[7]) / f,
    h[2] / f - (cx * h[8]) / f,
    h[3] / f - (cy * h[6]) / f,
    h[4] / f - (cy * h[7]) / f,
    h[5] / f - (cy * h[8]) / f,
    h[6],
    h[7],
    h[8],
  ];

  // 取列向量（此时位于“计算机视觉相机坐标”：图像 y 向下、+Z 向前）
  let r1 = new THREE.Vector3(g[0], g[3], g[6]);
  let r2 = new THREE.Vector3(g[1], g[4], g[7]);
  let t = new THREE.Vector3(g[2], g[5], g[8]);

  // CV 相机坐标 -> Three.js 场景坐标（+Y 向上、-Z 向前）：
  // 图像 y 向下对应 Three.js -Y；相机前方 +Z 对应 Three.js -Z。
  const flipCVtoThree = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.y, -v.z);
  r1 = flipCVtoThree(r1);
  r2 = flipCVtoThree(r2);
  t = flipCVtoThree(t);

  const scale = (r1.length() + r2.length()) / 2;
  if (scale < 1e-9) return null;
  r1.divideScalar(scale);
  r2.divideScalar(scale);
  t.divideScalar(scale);

  // 二维码应在相机前方：Three.js 中相机朝向 -Z，故 t.z < 0
  if (t.z > 0) {
    r1.multiplyScalar(-1);
    r2.multiplyScalar(-1);
    t.multiplyScalar(-1);
  }

  // Gram-Schmidt 正交化得到旋转矩阵 R = [e1, e2, e3]
  const e1 = r1.clone().normalize();
  const e2 = r2.clone().sub(e1.clone().multiplyScalar(r2.dot(e1))).normalize();
  const e3 = new THREE.Vector3().crossVectors(e1, e2).normalize();
  // 法线应朝向相机半球（二维码正面朝向相机）：
  // 不能用 e3.z>0 判定——二维码平放桌面时法线朝上(z≈0)，按 z 判定会误翻成朝下。
  const toCameraDir = t.clone().negate().normalize();
  if (e3.dot(toCameraDir) < 0) e3.multiplyScalar(-1);

  // PnP 迭代优化：大角度/角点噪声下，DLT 分解位姿漂移明显，用高斯-牛顿最小化重投影误差
  const R0 = new THREE.Matrix3().set(
    e1.x, e2.x, e3.x,
    e1.y, e2.y, e3.y,
    e1.z, e2.z, e3.z
  );
  const refined = refinePosePnP(R0, t, src, dst, f, cx, cy);
  if (refined) {
    t.copy(refined.t);
    // 从优化后的旋转矩阵重新取基向量（列主序）
    const re = refined.R.elements;
    const re1 = new THREE.Vector3(re[0], re[1], re[2]);
    const re2 = new THREE.Vector3(re[3], re[4], re[5]);
    let re3 = new THREE.Vector3(re[6], re[7], re[8]);
    // 优化后再次确保法线朝向相机
    if (re3.dot(toCameraDir) < 0) re3.multiplyScalar(-1);
    const out = {
      valid: true,
      position: t,
      quaternion: new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(re1, re2, re3)
      ),
      normal: re3,
    };
    return out;
  }

  return {
    valid: true,
    position: t,
    quaternion: new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(e1, e2, e3)
    ),
    normal: e3,
  };
}
