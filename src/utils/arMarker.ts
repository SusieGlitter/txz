/**
 * ARToolKit 3x3 PARITY65 barcode marker 生成工具（AR.js / jsartoolkit5 兼容）。
 *
 * AR.js 的 ArToolkitContext 支持 matrixCodeType: '3x3_PARITY65'，
 * 检测时按 AR_MATRIX_CODE_3x3_PARITY65 解码——与本文件的编码布局一一对应。
 * 布局（9 位，行主序，true=黑）：
 *   [0,0] 固定黑(同步)   [0,1] parity         [0,2] b0
 *   [1,0] b1             [1,1] b2             [1,2] b3
 *   [2,0] 固定黑(同步)   [2,1] b4             [2,2] 固定白(同步)
 */

/** 所有通行证共用的 AR 标记 id（0-31 范围，3x3_PARITY65 最多 32 种） */
export const AR_MARKER_VALUE = 1;

function intToBitArray(n: number, minWidth: number): boolean[] {
  const ret: boolean[] = [];
  while (n > 0) {
    ret.push((n & 1) !== 0);
    n >>= 1;
  }
  while (ret.length < minWidth) ret.push(false);
  return ret.reverse();
}

/** 将数值编码为 3x3_PARITY65 的 9 个格子（true=黑），值域 0-31 */
export function encode3x3Parity65(value: number): boolean[] {
  if (!Number.isInteger(value) || value < 0 || value >= 32) {
    throw new Error(`value out of range for 3x3_PARITY65: ${value}`);
  }
  const b = intToBitArray(value, 5);
  const parity = b.filter((x) => x).length % 2 === 1; // 5 位异或 = 奇数个 1
  return [
    true,
    parity,
    b[0],
    b[1],
    b[2],
    b[3],
    true,
    b[4],
    false,
  ];
}

/**
 * 生成 AR 标记图片的 dataURL。
 * 布局与 arjs-studio-backend / AR.js Studio 一致：黑底，中心 50% 区域为 3x3 网格。
 */
export function generateArMarkerDataURL(value: number = AR_MARKER_VALUE, size = 512): string {
  const bits = encode3x3Parity65(value);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  const inner = size * 0.5;
  const off = (size - inner) / 2;
  const cell = inner / 3;
  ctx.fillStyle = '#ffffff';
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      if (!bits[y * 3 + x]) {
        ctx.fillRect(off + x * cell, off + y * cell, cell, cell);
      }
    }
  }
  return canvas.toDataURL('image/png');
}
