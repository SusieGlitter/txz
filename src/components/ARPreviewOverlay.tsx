import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { X, ScanLine, VideoOff, RefreshCw, RotateCw } from 'lucide-react';
import { THREEx } from '@ar-js-org/ar.js-threejs';
import { CARD_W3D, CARD_H3D } from '../utils/diecutShape';
import { AR_MARKER_VALUE } from '../utils/arMarker';

// ---- AR.js / jsartoolkit5 相机参数（从 @ar-js-org/ar.js-threejs 复制到 public/data）----
const CAMERA_PARAMS_URL = '/data/camera_para.dat';
const STATUS_POLL_MS = 200; // 状态轮询间隔（marker 是否锁定）
const ROTATE_SPEED = 0.006; // 自动旋转角速度（与主预览一致）
const DEFAULT_PITCH = -0.35; // 初始前倾角（rad）

type StatusKind = 'starting' | 'searching' | 'locked' | 'error';

interface ARPreviewOverlayProps {
  passGroup: THREE.Group | null;
  qrSizeCm: number;
  autoRotate: boolean;
  onClose: () => void;
}

/**
 * 摄像头 AR（AR.js / jsartoolkit5）：
 * - 用 ARToolKit 3x3_PARITY65 barcode marker 定位（与生成的 AR 标记图一致）
 * - AR.js 负责检测、位姿估算、平滑（smooth）与 marker 丢失自动隐藏
 * - 通行证 3D 模型立在 marker 平面上，支持自动旋转与拖动旋转
 */
export const ARPreviewOverlay: React.FC<ARPreviewOverlayProps> = ({
  passGroup,
  qrSizeCm,
  autoRotate,
  onClose,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const arSourceRef = useRef<any>(null);
  const arContextRef = useRef<any>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const markerRootRef = useRef<THREE.Group | null>(null);
  const spinGroupRef = useRef<THREE.Group | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const rafRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);
  const closedRef = useRef<boolean>(false);

  const [status, setStatus] = useState<StatusKind>('starting');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [arAutoRotate, setArAutoRotate] = useState<boolean>(autoRotate);
  const autoRotateRef = useRef<boolean>(autoRotate);
  autoRotateRef.current = arAutoRotate;

  // 拖动旋转
  const draggingRef = useRef<boolean>(false);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    let active = true;

    const disposeAll = () => {
      active = false;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      const vid = document.getElementById('arjs-video') as HTMLVideoElement | null;
      if (vid) {
        if (vid.srcObject) {
          (vid.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
          vid.srcObject = null;
        }
        vid.remove();
      }
      if (rendererRef.current) {
        rendererRef.current.dispose();
        rendererRef.current.domElement.remove();
        rendererRef.current = null;
      }
    };

    const initArScene = () => {
      const arContext = new THREEx.ArToolkitContext({
        cameraParametersUrl: CAMERA_PARAMS_URL,
        detectionMode: 'mono_and_matrix', // 启用 matrix(条形码) 检测
        matrixCodeType: '3x3_PARITY65', // 与 arMarker.ts 的编码一致
        maxDetectionRate: 30,
        canvasWidth: 640,
        canvasHeight: 480,
        patternRatio: 0.5,
      });
      arContextRef.current = arContext;

      const scene = new THREE.Scene();
      sceneRef.current = scene;

      const camera = arContext.createDefaultCamera('artoolkit');
      cameraRef.current = camera;
      scene.add(camera);

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
      viewportRef.current?.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      // 层级：markerRoot(AR.js 位姿) -> spinGroup(自动/拖动旋转) -> 模型
      const markerRoot = new THREE.Group();
      scene.add(markerRoot);
      markerRootRef.current = markerRoot;

      const spinGroup = new THREE.Group();
      spinGroup.rotation.x = DEFAULT_PITCH;
      markerRoot.add(spinGroup);
      spinGroupRef.current = spinGroup;

      if (passGroup) {
        const model = passGroup.clone(true);
        const scale = qrSizeCm / 100 / CARD_W3D; // 卡片宽 = marker 边长 = qrSizeCm cm
        model.scale.setScalar(scale);
        // 模型局部原点在卡面中心，抬高半卡高使底边落在 marker 中心
        model.position.set(0, (CARD_H3D / 2) * scale, 0);
        spinGroup.add(model);
        modelRef.current = model;
      }

      // marker 检测控制：barcode value 与生成的标记图一致；AR.js 内置平滑与丢失隐藏
      new THREEx.ArMarkerControls(arContext, markerRoot, {
        type: 'barcode',
        barcodeValue: AR_MARKER_VALUE,
        changeMatrixMode: 'modelViewMatrix',
        size: qrSizeCm / 100, // marker 物理尺寸（米）
        smooth: true,
        smoothCount: 10,
        smoothTolerance: 0.01,
        smoothThreshold: 3,
      });

      arContext.init(() => {
        if (!active) return;
        camera.projectionMatrix.copy(arContext.getProjectionMatrix());
        setStatus('searching');
      });

      // 视口布局：视频与 3D 画布保持 video 比例居中，保证投影对齐
      const layout = () => {
        const root = rootRef.current;
        const viewport = viewportRef.current;
        const video = document.getElementById('arjs-video') as HTMLVideoElement | null;
        if (!root || !viewport || !rendererRef.current || !video) return;
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 480;
        const scale = Math.min(root.clientWidth / vw, root.clientHeight / vh);
        const w = Math.max(1, Math.floor(vw * scale));
        const h = Math.max(1, Math.floor(vh * scale));
        viewport.style.width = `${w}px`;
        viewport.style.height = `${h}px`;
        rendererRef.current.setSize(w, h);
      };
      layout();
      window.addEventListener('resize', layout);

      // 拖动旋转（spinGroup）
      const canvas = renderer.domElement;
      const onPointerDown = (e: PointerEvent) => {
        draggingRef.current = true;
        lastPointerRef.current = { x: e.clientX, y: e.clientY };
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

      // 渲染循环：AR 检测 + 自动旋转 + 渲染
      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        const ctx = arContextRef.current;
        const src = arSourceRef.current;
        // arController 在 init 完成后才可用，之前跳过检测与投影更新（避免同步异常）
        if (ctx && ctx.arController && src && src.ready) {
          ctx.update(src.domElement);
          if (cameraRef.current) {
            cameraRef.current.projectionMatrix.copy(ctx.getProjectionMatrix());
          }
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

      // 状态轮询：marker 被识别则 locked，否则 searching（AR.js 会自动隐藏模型）
      pollRef.current = window.setInterval(() => {
        const root = markerRootRef.current;
        if (root) setStatus(root.visible ? 'locked' : 'searching');
      }, STATUS_POLL_MS);
    };

    const arSource = new THREEx.ArToolkitSource({
      sourceType: 'webcam',
      sourceWidth: 640,
      sourceHeight: 480,
    });
    arSourceRef.current = arSource;

    arSource.init(
      () => {
        if (!active) return;
        setCameraError(null);
        // AR.js 把 video 挂到 body，移入组件容器并铺满
        const vid = document.getElementById('arjs-video') as HTMLVideoElement | null;
        if (vid && viewportRef.current) {
          vid.style.position = 'absolute';
          vid.style.inset = '0';
          vid.style.width = '100%';
          vid.style.height = '100%';
          vid.style.objectFit = 'fill';
          viewportRef.current.appendChild(vid);
        }
        initArScene();
      },
      (err: any) => {
        if (!active || closedRef.current) return;
        console.error('摄像头启动失败:', err);
        setCameraError(
          err?.name === 'NotAllowedError'
            ? '摄像头权限被拒绝，请在浏览器设置中允许访问摄像头'
            : err?.message || '无法访问摄像头，请检查设备连接与浏览器权限'
        );
        setStatus('error');
      }
    );

    return disposeAll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          {status === 'searching' && <ScanLine className="w-3.5 h-3.5 text-amber-400" />}
          {status === 'error' && <VideoOff className="w-3.5 h-3.5 text-red-400" />}
          <span className="font-medium">
            {status === 'starting' && '正在启动摄像头...'}
            {status === 'searching' && '正在寻找 AR 标记…'}
            {status === 'locked' && '已识别 AR 标记，模型已放置于标记上方'}
            {status === 'error' && '摄像头启动失败'}
          </span>
          <span className="text-slate-500 ml-2">识别引擎：AR.js / ARToolKit</span>
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
