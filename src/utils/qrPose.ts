import * as THREE from 'three';

export interface QRPose {
  valid: boolean;
  /** 二维码中心在相机坐标系中的位置（单位与 qrSizeCm 一致，cm） */
  position: THREE.Vector3;
  /** 二维码平面的旋转（相机坐标系），平面局部 +Z = 平面法线（朝向相机） */
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

  // 取列向量
  let r1 = new THREE.Vector3(g[0], g[3], g[6]);
  let r2 = new THREE.Vector3(g[1], g[4], g[7]);
  let t = new THREE.Vector3(g[2], g[5], g[8]);

  const scale = (r1.length() + r2.length()) / 2;
  if (scale < 1e-9) return null;
  r1.divideScalar(scale);
  r2.divideScalar(scale);
  t.divideScalar(scale);

  // 二维码应在相机前方：t.z > 0
  if (t.z < 0) {
    r1.multiplyScalar(-1);
    r2.multiplyScalar(-1);
    t.multiplyScalar(-1);
  }

  // Gram-Schmidt 正交化得到旋转矩阵 R = [e1, e2, e3]
  const e1 = r1.clone().normalize();
  const e2 = r2.clone().sub(e1.clone().multiplyScalar(r2.dot(e1))).normalize();
  const e3 = new THREE.Vector3().crossVectors(e1, e2).normalize();
  // 法线应指向相机（+z 分量 > 0）
  if (e3.z < 0) e3.multiplyScalar(-1);

  return {
    valid: true,
    position: t,
    quaternion: new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(e1, e2, e3)
    ),
    normal: e3,
  };
}
