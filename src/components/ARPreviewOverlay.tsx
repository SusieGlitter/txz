import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { X, ScanLine, VideoOff, RefreshCw, RotateCw } from 'lucide-react';
import jsQR from 'jsqr';
import { estimateQRPose, QRPose } from '../utils/qrPose';
import { CARD_W3D, CARD_H3D } from '../utils/diecutShape';

// ---- BarcodeDetector 原生 API 类型声明（Chrome/Edge 支持，不在 lib.dom 中）----
interface DetectedBarcode {
  rawValue: string;
  cornerPoints: Array<{ x: number; y: number }>;
  boundingBox: DOMRectReadOnly;
  format: string;
}
interface BarcodeDetectorInstance {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats(): Promise<string[]>;
}
declare global {
  // eslint-disable-next-line no-var
  var BarcodeDetector: BarcodeDetectorCtor | undefined;
}

interface ARPreviewOverlayProps {
  passGroup: THREE.Group | null;
  qrText: string;
  qrSizeCm: number;
  autoRotate: boolean;
  onClose: () => void;
}

const CAMERA_FOV = 45; // 固定垂直视场角假设（无需校准），位姿估算与渲染相机一致
const DETECT_INTERVAL = 150; // 检测间隔 ms
const JSQR_MAX_SCAN = 960; // jsQR 扫描的最大宽度（更高分辨率有助于识别小二维码）
const ROTATE_SPEED = 0.006; // 自动旋转角速度（与主预览一致）
const SMOOTH = 0.12; // 位置/角度/大小平滑系数（每帧向目标逼近的比例，越小越平稳）

type DetectorKind = 'native' | 'jsqr';
type StatusKind = 'starting' | 'searching' | 'mismatch' | 'locked' | 'error';

// ---- 位姿稳定性辅助 ----

/** 4 个角点可能的旋转排列（二维码存在 90° 旋转歧义：哪条边在前面） */
const CORNER_PERMS = [
  [0, 1, 2, 3],
  [1, 2, 3, 0],
  [2, 3, 0, 1],
  [3, 0, 1, 2],
];

/**
 * 角点指数平滑（减少 jsQR/原生检测的帧间抖动）。
 * 仅当二维码像素尺寸突变剧烈（>75%，视为重扫/跳变）才重置平滑器。
 */
function smoothCorners(
  raw: Array<{ x: number; y: number }>,
  prev: Array<{ x: number; y: number }> | null
): Array<{ x: number; y: number }> {
  if (!prev) return raw.map((c) => ({ x: c.x, y: c.y }));
  const diag = (c: Array<{ x: number; y: number }>) =>
    Math.hypot(c[2].x - c[0].x, c[2].y - c[0].y);
  const d = diag(raw);
  const pd = diag(prev);
  if (pd > 1e-6 && Math.abs(d - pd) / pd > 0.75) {
    return raw.map((c) => ({ x: c.x, y: c.y }));
  }
  const alpha = 0.65; // 平滑系数（越大越贴近最新检测，越小越稳）
  return raw.map((c, i) => ({
    x: prev[i].x + (c.x - prev[i].x) * alpha,
    y: prev[i].y + (c.y - prev[i].y) * alpha,
  }));
}

/**
 * 方向消歧：原生 BarcodeDetector 的角点顺序不保证与二维码方向对齐，
 * 按 4 个旋转排列各解一次位姿，取与上一帧旋转最接近的解（|quaternion 点积| 最大），
 * 从而稳定"哪条边在前面"。无参考帧时默认取原始顺序。
 */
function disambiguatePose(
  corners: Array<{ x: number; y: number }>,
  imageWidth: number,
  imageHeight: number,
  qrSizeCm: number,
  fovYDeg: number,
  refQuat: THREE.Quaternion | null
): QRPose | null {
  let best: QRPose | null = null;
  let bestScore = -Infinity;
  for (let k = 0; k < CORNER_PERMS.length; k++) {
    const p = CORNER_PERMS[k];
    const c = [corners[p[0]], corners[p[1]], corners[p[2]], corners[p[3]]];
    const pose = estimateQRPose(c, imageWidth, imageHeight, qrSizeCm, fovYDeg);
    if (!pose) continue;
    let score = 0;
    if (refQuat) {
      const q = pose.quaternion;
      // quaternion 与 -quaternion 等价，取绝对值
      score = Math.abs(q.x * refQuat.x + q.y * refQuat.y + q.z * refQuat.z + q.w * refQuat.w);
    } else {
      score = -k; // 无参考：原始顺序优先
    }
    if (score > bestScore) {
      bestScore = score;
      best = pose;
    }
  }
  return best;
}

/**
 * 摄像头 AR：识别二维码后把通行证 3D 模型"立"在二维码平面上。
 * - 通过单应矩阵估算二维码平面位姿（固定焦距假设），模型底面贴合二维码平面
 * - 透视渲染 3D 模型，支持按配置自动旋转与拖动旋转
 */
export const ARPreviewOverlay: React.FC<ARPreviewOverlayProps> = ({
  passGroup,
  qrText,
  qrSizeCm,
  autoRotate,
  onClose,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const closedRef = useRef<boolean>(false);

  // Three.js（透视相机）
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const anchorGroupRef = useRef<THREE.Group | null>(null); // 贴合二维码的锚点组
  const spinGroupRef = useRef<THREE.Group | null>(null); // 自动/拖动旋转
  const modelRef = useRef<THREE.Group | null>(null);
  const rafRef = useRef<number | null>(null);
  const targetPoseRef = useRef<{ position: THREE.Vector3; quaternion: THREE.Quaternion; scale: number }>({
    position: new THREE.Vector3(0, 0, 0),
    quaternion: new THREE.Quaternion(),
    scale: 0,
  });

  // 位姿稳定性：角点平滑、方向消歧参考、卡片朝向锁定（二维码本地坐标系）
  const smoothCornersRef = useRef<Array<{ x: number; y: number }> | null>(null);
  const lastPoseQuatRef = useRef<THREE.Quaternion | null>(null);
  const lockDirRef = useRef<THREE.Vector3 | null>(null);
  const lastPoseRef = useRef<QRPose | null>(null); // 上一帧位姿（帧间 PnP 初值）

  // 摄像头 / 检测
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorInstance | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<number | null>(null);
  const lastDetectRef = useRef<number>(0);
  const qrSizeCmRef = useRef<number>(qrSizeCm);
  qrSizeCmRef.current = qrSizeCm;

  // 旋转控制
  const autoRotateRef = useRef<boolean>(autoRotate);
  const draggingRef = useRef<boolean>(false);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [status, setStatus] = useState<StatusKind>('starting');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [detectorKind, setDetectorKind] = useState<DetectorKind | 'none'>('none');
  const [arAutoRotate, setArAutoRotate] = useState<boolean>(autoRotate);
  autoRotateRef.current = arAutoRotate;

  // ---------- 初始化：摄像头 + 检测器 + 3D 场景 ----------
  useEffect(() => {
    let active = true;
    let resizeHandler: (() => void) | null = null;
    let pointerCleanup: (() => void) | null = null;

    const disposeAll = () => {
      active = false;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (rendererRef.current) {
        rendererRef.current.dispose();
        if (rendererRef.current.domElement.parentElement) {
          rendererRef.current.domElement.parentElement.removeChild(rendererRef.current.domElement);
        }
        rendererRef.current = null;
      }
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
      if (pointerCleanup) pointerCleanup();
      pointerCleanup = null;
    };

    (async () => {
      const video = videoRef.current;
      if (!video) return;

      // 优先后置摄像头（environment），失败后回退默认摄像头
      try {
        await navigator.mediaDevices
          .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
          .then((stream) => {
            streamRef.current = stream;
            video.srcObject = stream;
            return video.play();
          });
      } catch (err) {
        if (!active) return;
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        video.srcObject = stream;
        await video.play();
      }
      if (!active) return;

      setCameraError(null);

      // 初始化检测器：优先原生 BarcodeDetector，否则 jsQR
      try {
        const Ctor = typeof window !== 'undefined' ? window.BarcodeDetector : undefined;
        if (Ctor && Ctor.getSupportedFormats) {
          const formats = await Ctor.getSupportedFormats();
          if (formats.includes('qr_code')) {
            detectorRef.current = new Ctor({ formats: ['qr_code'] });
            setDetectorKind('native');
          }
        }
      } catch (err) {
        console.warn('BarcodeDetector 不可用，回退到 jsQR:', err);
      }
      if (!detectorRef.current) setDetectorKind('jsqr');
      if (!active) return;

      // 初始化 3D 场景
      const scene = new THREE.Scene();
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(
        CAMERA_FOV,
        (video.videoWidth || 1) / (video.videoHeight || 1),
        0.1,
        500
      );
      cameraRef.current = camera;

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        premultipliedAlpha: false,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.style.position = 'absolute';
      renderer.domElement.style.inset = '0';
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.cursor = 'grab';
      renderer.domElement.style.touchAction = 'none';
      viewportRef.current?.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      // 灯光
      const ambient = new THREE.AmbientLight(0xffffff, 1.0);
      scene.add(ambient);
      const hemi = new THREE.HemisphereLight(0xffffff, 0x8899bb, 0.6);
      scene.add(hemi);
      const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
      dirLight.position.set(3, 5, 4);
      scene.add(dirLight);
      const dirLight2 = new THREE.DirectionalLight(0xbbe1ff, 0.6);
      dirLight2.position.set(-4, 2, 3);
      scene.add(dirLight2);

      // 模型层级：anchorGroup(贴合二维码) -> spinGroup(自动/拖动旋转) -> 模型
      // 关键：anchorGroup 本地 +Y = 二维码平面内的垂直方向(局部 +Y/e2)，因此
      // 旋转轴(spinGroup.rotation.y 绕 anchor 本地 Y) 恒与二维码平面垂直方向平行；
      // 模型沿 +Y 抬升 → 卡片中轴 = 平面内垂直方向，卡片立在二维码上、正面朝向相机。
      const anchorGroup = new THREE.Group();
      scene.add(anchorGroup);
      anchorGroupRef.current = anchorGroup;
      const spinGroup = new THREE.Group();
      anchorGroup.add(spinGroup);
      spinGroupRef.current = spinGroup;

      if (passGroup) {
        const model = passGroup.clone(true);
        model.visible = false;
        spinGroup.add(model);
        modelRef.current = model;
      }

      // 按二维码位姿放置锚点：模型底边中点贴合二维码中心，卡片立于二维码平面
      const applyPose = (pose: QRPose) => {
        const model = modelRef.current;
        if (!model) return;
        // 只记录目标值，位置/角度/大小统一在渲染循环里平滑逼近
        targetPoseRef.current.scale = qrSizeCmRef.current / CARD_W3D;

        // 卡片中轴 = 二维码平面内的"垂直方向"（图形上下方向，pose 局部 +Y = e2）
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
        // 卡片正面朝向：锁定在二维码本地坐标系（首次朝相机，之后相对二维码固定），
        // 这样转动视角时能看到卡片的不同面（真实 3D 物体行为），而非总面向相机
        let f: THREE.Vector3;
        if (lockDirRef.current) {
          f = lockDirRef.current.clone().applyQuaternion(pose.quaternion);
        } else {
          const toCam = pose.position.clone().negate();
          let f0 = toCam.clone().sub(up.clone().multiplyScalar(toCam.dot(up)));
          if (f0.lengthSq() < 1e-8) {
            f0 = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
          }
          f0.normalize();
          // 转到二维码本地坐标系后固定
          lockDirRef.current = f0.clone().applyQuaternion(pose.quaternion.clone().invert());
          f = f0;
        }
        const right = new THREE.Vector3().crossVectors(up, f).normalize();
        const rot = new THREE.Matrix4().makeBasis(right, up, f);

        targetPoseRef.current.position.copy(pose.position);
        targetPoseRef.current.quaternion.setFromRotationMatrix(rot);
        model.visible = true;
      };

      resizeHandler = () => {
        const root = rootRef.current;
        const viewport = viewportRef.current;
        if (!root || !viewport || !rendererRef.current || !cameraRef.current) return;
        const vw = video.videoWidth || 1;
        const vh = video.videoHeight || 1;
        const scale = Math.min(root.clientWidth / vw, root.clientHeight / vh);
        const w = Math.max(1, Math.floor(vw * scale));
        const h = Math.max(1, Math.floor(vh * scale));
        viewport.style.width = `${w}px`;
        viewport.style.height = `${h}px`;
        rendererRef.current.setSize(w, h);
        cameraRef.current.aspect = vw / vh;
        cameraRef.current.updateProjectionMatrix();
      };
      resizeHandler();
      window.addEventListener('resize', resizeHandler);
      if (!active) {
        disposeAll();
        return;
      }

      // 拖动旋转（拖拽模型本身，保持锚定在二维码上）
      const canvas = renderer.domElement;
      const onPointerDown = (e: PointerEvent) => {
        draggingRef.current = true;
        lastPointerRef.current = { x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!draggingRef.current) return;
        const dx = e.clientX - lastPointerRef.current.x;
        const dy = e.clientY - lastPointerRef.current.y;
        lastPointerRef.current = { x: e.clientX, y: e.clientY };
        const spin = spinGroupRef.current;
        if (!spin) return;
        spin.rotation.y -= dx * 0.01;
        spin.rotation.x = THREE.MathUtils.clamp(spin.rotation.x - dy * 0.01, -1.2, 1.2);
      };
      const onPointerUp = () => {
        draggingRef.current = false;
        canvas.style.cursor = 'grab';
      };
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      pointerCleanup = () => {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
      };

      // 渲染循环：锚点平滑跟随 + 模型大小平滑 + 自动旋转
      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        const anchor = anchorGroupRef.current;
        if (anchor) {
          anchor.position.lerp(targetPoseRef.current.position, SMOOTH);
          anchor.quaternion.slerp(targetPoseRef.current.quaternion, SMOOTH);
        }
        const model = modelRef.current;
        if (model && model.visible) {
          // 大小平滑逼近目标
          const targetScale = targetPoseRef.current.scale;
          const curScale = model.scale.x;
          const ns = curScale + (targetScale - curScale) * SMOOTH;
          model.scale.setScalar(ns);
          // 模型局部原点在卡面中心，抬高半卡高使底边落在锚点原点（二维码中心）
          model.position.set(0, (CARD_H3D / 2) * ns, 0);
        }
        const spin = spinGroupRef.current;
        if (spin && autoRotateRef.current && !draggingRef.current) {
          spin.rotation.y += ROTATE_SPEED;
        }
        if (rendererRef.current && sceneRef.current && cameraRef.current) {
          rendererRef.current.render(sceneRef.current, cameraRef.current);
        }
      };
      tick();

      // 检测循环
      const detectOnce = async (): Promise<{ kind: 'match' | 'other' | 'none'; pose?: QRPose }> => {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return { kind: 'none' };
        const target = qrText.trim();

        // 角点平滑 + 位姿求解。
        // updateRef=true（jsQR 主路径）：角点顺序已归一化，无需 4 向消歧，
        //   直接用上帧位姿作 PnP 初值做"帧间跟踪"，并做离群抑制，保证连续帧位姿稳定；
        // updateRef=false（原生路径）：角点顺序不保证，用 4 向消歧，不写方向参考。
        const refinePose = (
          cornersRaw: Array<{ x: number; y: number }>,
          updateRef: boolean
        ): QRPose | null => {
          // 丢失过久（>800ms）则重置参考，让重新检测以默认方向重新锁定
          if (Date.now() - lastDetectRef.current > 800) {
            lastPoseQuatRef.current = null;
            smoothCornersRef.current = null;
            lockDirRef.current = null;
            lastPoseRef.current = null;
          }
          const sm = smoothCorners(cornersRaw, smoothCornersRef.current);
          smoothCornersRef.current = sm;
          if (updateRef) {
            const last = lastPoseRef.current;
            const initPose = last
              ? {
                  R: new THREE.Matrix3().setFromMatrix4(
                    new THREE.Matrix4().makeRotationFromQuaternion(last.quaternion)
                  ),
                  t: last.position.clone(),
                }
              : undefined;
            const pose = estimateQRPose(sm, vw, vh, qrSizeCmRef.current, CAMERA_FOV, initPose);
            if (!pose) return null;
            // 离群抑制：与上一帧位置跳变过大则丢弃本帧（模型保持上帧位姿）
            if (last && pose.position.distanceTo(last.position) > 10) return null;
            lastPoseRef.current = pose;
            lastPoseQuatRef.current = pose.quaternion.clone();
            return pose;
          }
          const pose = disambiguatePose(
            sm,
            vw,
            vh,
            qrSizeCmRef.current,
            CAMERA_FOV,
            lastPoseQuatRef.current
          );
          return pose;
        };

        let jsqrPose: QRPose | null = null;
        let jsqrSawOther = false;

        // 1) jsQR 主检测（方向归一化，稳定"哪条边在前面"）
        try {
          const scan =
            scanCanvasRef.current || (scanCanvasRef.current = document.createElement('canvas'));
          const ctx = scan.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            const maxW = JSQR_MAX_SCAN;
            const scale = Math.min(1, maxW / vw);
            scan.width = Math.max(1, Math.floor(vw * scale));
            scan.height = Math.max(1, Math.floor(vh * scale));
            ctx.drawImage(video, 0, 0, scan.width, scan.height);
            const img = ctx.getImageData(0, 0, scan.width, scan.height);
            const code = jsQR(img.data, scan.width, scan.height, {
              inversionAttempts: 'attemptBoth',
            });
            if (code) {
              const matches = target === '' || code.data.trim() === target;
              const loc = code.location;
              const corners = [
                loc.topLeftCorner,
                loc.topRightCorner,
                loc.bottomRightCorner,
                loc.bottomLeftCorner,
              ].map((p) => ({ x: p.x / scale, y: p.y / scale }));
              if (matches) {
                jsqrPose = refinePose(corners, true);
              } else {
                jsqrSawOther = true;
              }
            }
          }
        } catch (err) {
          // jsQR 失败忽略
        }
        if (jsqrPose) return { kind: 'match', pose: jsqrPose };

        // 2) 原生 BarcodeDetector 补充（角点顺序不保证，仅消歧、不写方向参考）
        let nativePose: QRPose | null = null;
        let nativeSawOther = false;
        const detector = detectorRef.current;
        if (detector) {
          try {
            const codes = await detector.detect(video);
            for (const c of codes) {
              if (!c.cornerPoints || c.cornerPoints.length !== 4) continue;
              const matches = target === '' || c.rawValue.trim() === target;
              if (matches) {
                const pose = refinePose(c.cornerPoints, false);
                if (pose) {
                  nativePose = pose;
                  break;
                }
              } else {
                nativeSawOther = true;
              }
            }
          } catch (err) {
            // 原生检测异常时忽略，下一次再试
          }
        }
        if (nativePose) return { kind: 'match', pose: nativePose };
        if (jsqrSawOther || nativeSawOther) return { kind: 'other' };
        return { kind: 'none' };
      };

      const detectLoop = async () => {
        const result = await detectOnce();
        if (!active || closedRef.current) return;
        if (result.kind === 'match' && result.pose) {
          lastDetectRef.current = Date.now();
          applyPose(result.pose);
          setStatus('locked');
        } else if (result.kind === 'other') {
          setStatus((s) => {
            // 目标二维码已丢失（误扫到其他二维码）：同样给 1500ms 宽限后退出 locked
            if (s === 'locked') {
              return Date.now() - lastDetectRef.current < 1500 ? 'locked' : 'mismatch';
            }
            return 'mismatch';
          });
        } else {
          setStatus((s) => {
            if (s === 'locked') {
              return Date.now() - lastDetectRef.current < 1500 ? 'locked' : 'searching';
            }
            return 'searching';
          });
        }
      };
      intervalRef.current = window.setInterval(detectLoop, DETECT_INTERVAL);

      setStatus('searching');
    })().catch((err: any) => {
      console.error('摄像头初始化失败:', err);
      if (!active || closedRef.current) return;
      setCameraError(
        err?.name === 'NotAllowedError'
          ? '摄像头权限被拒绝，请在浏览器设置中允许访问摄像头'
          : '无法访问摄像头，请检查设备连接与浏览器权限'
      );
      setStatus('error');
    });

    return disposeAll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 扫不到二维码（退出 locked 状态）时隐藏模型，避免悬浮在画面上
  useEffect(() => {
    if (modelRef.current) modelRef.current.visible = status === 'locked';
  }, [status]);

  // 全屏进入/退出
  useEffect(() => {
    const root = rootRef.current;
    if (root && root.requestFullscreen && !document.fullscreenElement) {
      root.requestFullscreen().catch(() => {});
    }
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && !closedRef.current) {
        onClose();
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = () => {
    closedRef.current = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    onClose();
  };

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 bg-black flex items-center justify-center overflow-hidden"
    >
      {/* 视频 + WebGL 画布（保持视频原始宽高比居中） */}
      <div ref={viewportRef} className="relative">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-fill"
        />
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-300">
            <VideoOff className="w-10 h-10 text-red-400" />
            <p className="text-sm">{cameraError || '摄像头不可用'}</p>
            <button
              onClick={handleClose}
              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs hover:bg-slate-700"
            >
              关闭
            </button>
          </div>
        )}
      </div>

      {/* 顶部工具栏 */}
      <div className="absolute top-0 inset-x-0 p-3 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/60 backdrop-blur-sm text-slate-200 text-xs">
          {status === 'starting' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />}
          {status === 'locked' && <span className="w-2 h-2 rounded-full bg-green-400" />}
          {(status === 'searching' || status === 'mismatch') && (
            <ScanLine className="w-3.5 h-3.5 text-amber-400" />
          )}
          {status === 'error' && <VideoOff className="w-3.5 h-3.5 text-red-400" />}
          <span className="font-medium">
            {status === 'starting' && '正在启动摄像头'}
            {status === 'searching' && '正在识别二维码'}
            {status === 'mismatch' && '检测到其他二维码'}
            {status === 'locked' && '已识别到二维码'}
            {status === 'error' && '摄像头启动失败'}
          </span>
          <span className="text-slate-500 ml-2">
            识别引擎：
            {detectorKind === 'native'
              ? '原生 BarcodeDetector'
              : detectorKind === 'jsqr'
                ? 'jsQR'
                : '未初始化'}
          </span>
        </div>
        <div className="flex items-center gap-2 pointer-events-auto">
          <button
            onClick={() => setArAutoRotate((prev) => !prev)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold backdrop-blur-sm transition ${
              arAutoRotate
                ? 'bg-blue-600 text-white shadow'
                : 'bg-black/60 text-slate-300 hover:text-white'
            }`}
            title={arAutoRotate ? '停止自动旋转' : '开启自动旋转'}
          >
            <RotateCw
              className={`w-4 h-4 ${arAutoRotate ? 'animate-spin [animation-duration:8s]' : ''}`}
            />
            {arAutoRotate ? '自动旋转中' : '已暂停旋转'}
          </button>
          <button
            onClick={handleClose}
            className="p-2 rounded-lg bg-black/60 backdrop-blur-sm text-slate-200 hover:bg-black/80 hover:text-white transition"
            title="关闭摄像头"
            aria-label="关闭摄像头"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
