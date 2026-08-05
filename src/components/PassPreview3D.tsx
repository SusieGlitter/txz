import React, { useRef, useEffect, useState, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  RotateCw,
  Layers,
  Sparkles,
  Maximize2,
  Sliders,
  Sun,
  Eye,
  Settings,
  HelpCircle,
  RefreshCw,
} from 'lucide-react';
import { PassCardInfo, E1Options, DEFAULT_LAYER_VISIBILITY } from '../types';
import {
  renderFrontCard,
  renderBackCard,
  loadImage,
  preloadPsdAssets,
  getDiecutMask,
  CARD_WIDTH,
  CARD_HEIGHT,
} from '../utils/passRenderer';

interface PassPreview3DProps {
  info: PassCardInfo;
  e1Opts: E1Options;
  frontPhotoUrl: string;
  cutoutPhotoUrl: string;
  customIconUrl: string;
}

export const PassPreview3D: React.FC<PassPreview3DProps> = ({
  info,
  e1Opts,
  frontPhotoUrl,
  cutoutPhotoUrl,
  customIconUrl,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Modeler Control States
  const [thickness, setThickness] = useState<number>(0.4); // Thickness in cm
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const autoRotateRef = useRef<boolean>(autoRotate);
  autoRotateRef.current = autoRotate; // Instantly assign during render to avoid 1-frame latency
  // const [acrylicTint, setAcrylicTint] = useState<string>('#ffffff'); // Default to clear transparent white
  const [lightIntensity, setLightIntensity] = useState<number>(1.2);
  const [isPreloading, setIsPreloading] = useState<boolean>(true);
  const [isUpdatingTextures, setIsUpdatingTextures] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Hidden offscreen canvas refs for texture rendering
  const frontCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frontBackingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const middleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const backCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Three.js object references for dynamic updates
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);

  // Geometry and Mesh references
  const acrylicMeshRef = useRef<THREE.Mesh | null>(null);
  const frontMeshRef = useRef<THREE.Mesh | null>(null);
  const frontBackingMeshRef = useRef<THREE.Mesh | null>(null);
  const middleMeshRef = useRef<THREE.Mesh | null>(null);
  const backMeshRef = useRef<THREE.Mesh | null>(null);

  // Texture references
  const frontTexRef = useRef<THREE.CanvasTexture | null>(null);
  const frontBackingTexRef = useRef<THREE.CanvasTexture | null>(null);
  const middleTexRef = useRef<THREE.CanvasTexture | null>(null);
  const backTexRef = useRef<THREE.CanvasTexture | null>(null);

  // Track loaded asset URLs to avoid redundant draw operations
  const [canvasKey, setCanvasKey] = useState<number>(0);

  const toggleFullscreen = async () => {
    const target = containerRef.current;
    if (!target) return;

    try {
      if (!document.fullscreenElement) {
        await target.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (error) {
      console.error('Fullscreen toggle failed:', error);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // 1. Initial preload of PSD assets and fonts
  useEffect(() => {
    let active = true;
    async function initPreload() {
      try {
        await preloadPsdAssets();
        if (active) setIsPreloading(false);
      } catch (err) {
        console.error('Error preloading 3D assets:', err);
        if (active) setIsPreloading(false);
      }
    }
    initPreload();
    return () => {
      active = false;
    };
  }, []);

  // 2. Offscreen Canvas Initializer
  useEffect(() => {
    // Create canvas elements once
    frontCanvasRef.current = document.createElement('canvas');
    frontCanvasRef.current.width = CARD_WIDTH;
    frontCanvasRef.current.height = CARD_HEIGHT;

    frontBackingCanvasRef.current = document.createElement('canvas');
    frontBackingCanvasRef.current.width = CARD_WIDTH;
    frontBackingCanvasRef.current.height = CARD_HEIGHT;

    middleCanvasRef.current = document.createElement('canvas');
    middleCanvasRef.current.width = CARD_WIDTH;
    middleCanvasRef.current.height = CARD_HEIGHT;

    backCanvasRef.current = document.createElement('canvas');
    backCanvasRef.current.width = CARD_WIDTH;
    backCanvasRef.current.height = CARD_HEIGHT;
  }, []);

  // 3. Texture Generator (triggers whenever input info/photos change)
  useEffect(() => {
    if (isPreloading) return;

    let isMounted = true;

    async function generateTextures() {
      if (isMounted) setIsUpdatingTextures(true);

      const frontCanvas = frontCanvasRef.current;
      const frontBackingCanvas = frontBackingCanvasRef.current;
      const middleCanvas = middleCanvasRef.current;
      const backCanvas = backCanvasRef.current;

      if (!frontCanvas || !frontBackingCanvas || !middleCanvas || !backCanvas) return;

      const frontCtx = frontCanvas.getContext('2d');
      const frontBackingCtx = frontBackingCanvas.getContext('2d');
      const middleCtx = middleCanvas.getContext('2d');
      const backCtx = backCanvas.getContext('2d');

      if (!frontCtx || !frontBackingCtx || !middleCtx || !backCtx) return;

      try {
        // Load custom uploads
        const [img1Obj, cutoutObj, customIconObj] = await Promise.all([
          frontPhotoUrl ? loadImage(frontPhotoUrl) : Promise.resolve(null),
          cutoutPhotoUrl ? loadImage(cutoutPhotoUrl) : Promise.resolve(null),
          customIconUrl ? loadImage(customIconUrl) : Promise.resolve(null),
        ]);

        if (!isMounted) return;

        // --- A. Draw Front Print Layer ---
        // Contains border overlay, barcode, names, and texts but NO cutout, NO baseboard, NO faction watermark
        frontCtx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
        await renderFrontCard(
          frontCtx,
          info,
          null, // No image on front surface
          e1Opts,
          null, // No custom icon here
          {
            ...DEFAULT_LAYER_VISIBILITY,
            background: false, // Transparent glass overlay
            characterPhoto: false, // In the middle layer
            baseboard: false, // In the middle layer
            factionWatermark: false, // In the middle layer
          }
        );

        // --- B. Draw Front White Backing Layer ---
        // For standard UV single-sided white printing: any printed front pixel is backed by opaque white ink.
        // Looking from inside-out, these areas appear solid white.
        frontBackingCtx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
        frontBackingCtx.drawImage(frontCanvas, 0, 0);
        const frontImgData = frontBackingCtx.getImageData(0, 0, CARD_WIDTH, CARD_HEIGHT);
        const frontPixels = frontImgData.data;
        for (let i = 0; i < frontPixels.length; i += 4) {
          // If the pixel has any opacity, force it to opaque white (#ffffff, a=255)
          if (frontPixels[i + 3] > 10) {
            frontPixels[i] = 255;
            frontPixels[i + 1] = 255;
            frontPixels[i + 2] = 255;
            frontPixels[i + 3] = 255;
          } else {
            frontPixels[i + 3] = 0;
          }
        }
        frontBackingCtx.putImageData(frontImgData, 0, 0);

        // --- C. Draw Middle Print Layer ---
        // Contains the character cutout standing, E1 baseboard, and faction icon
        middleCtx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
        await renderFrontCard(
          middleCtx,
          info,
          img1Obj,
          e1Opts,
          customIconObj,
          {
            background: false, // Transparent middle layer
            characterPhoto: true,
            baseboard: true,
            factionWatermark: true,
            barcode: false,
            idAndNameText: false,
            professionFactionText: false,
            borderOverlay: false,
          },
          cutoutObj
        );

        // --- D. Draw Back Print Layer ---
        // Outer back print, which is double-sided graphic background with character silhouette
        backCtx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
        await renderBackCard(
          backCtx,
          info,
          cutoutObj, // Pass the cutout photo
          e1Opts,
          img1Obj,   // Pass the front photo if cutout is not available
          {
            ...DEFAULT_LAYER_VISIBILITY,
            characterPhoto: true, // Keep character silhouette enabled on back face
          }
        );

        // Notify Three.js textures that contents changed
        if (frontTexRef.current) frontTexRef.current.needsUpdate = true;
        if (frontBackingTexRef.current) frontBackingTexRef.current.needsUpdate = true;
        if (middleTexRef.current) middleTexRef.current.needsUpdate = true;
        if (backTexRef.current) backTexRef.current.needsUpdate = true;

        if (isMounted) {
          setCanvasKey((prev) => prev + 1);
          setIsUpdatingTextures(false);
        }
      } catch (err) {
        console.error('Failed generating textures in 3D:', err);
        if (isMounted) setIsUpdatingTextures(false);
      }
    }

    generateTextures();

    return () => {
      isMounted = false;
    };
  }, [isPreloading, info, e1Opts, frontPhotoUrl, cutoutPhotoUrl, customIconUrl]);

  // 4. Initialize and Render 3D Canvas Scene
  useEffect(() => {
    if (isPreloading || !containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 550;

    // A. Scene Setup
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // B. Camera Setup
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 0, 16);

    // C. WebGL Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Fix color space
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // D. Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 6;
    controls.maxDistance = 30;
    controls.maxPolarAngle = Math.PI / 1.1; // Don't let users go completely under the table
    controlsRef.current = controls;

    // E. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, lightIntensity * 0.8);
    dirLight1.position.set(5, 8, 5);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.width = 1024;
    dirLight1.shadow.mapSize.height = 1024;
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xbbe1ff, lightIntensity * 0.4);
    dirLight2.position.set(-8, -4, 4);
    scene.add(dirLight2);

    // Dynamic point light following camera to give polished acrylic specular highlights
    const pointLight = new THREE.PointLight(0xffffff, 0.8, 50);
    scene.add(pointLight);

    // F. Texture Bindings
    const frontCanvas = frontCanvasRef.current || document.createElement('canvas');
    const frontBackingCanvas = frontBackingCanvasRef.current || document.createElement('canvas');
    const middleCanvas = middleCanvasRef.current || document.createElement('canvas');
    const backCanvas = backCanvasRef.current || document.createElement('canvas');

    const frontTex = new THREE.CanvasTexture(frontCanvas);
    frontTex.colorSpace = THREE.SRGBColorSpace;
    frontTexRef.current = frontTex;

    const frontBackingTex = new THREE.CanvasTexture(frontBackingCanvas);
    frontTexRef.current.needsUpdate = true;
    frontBackingTexRef.current = frontBackingTex;

    const middleTex = new THREE.CanvasTexture(middleCanvas);
    middleTex.colorSpace = THREE.SRGBColorSpace;
    middleTexRef.current = middleTex;

    const backTex = new THREE.CanvasTexture(backCanvas);
    backTex.colorSpace = THREE.SRGBColorSpace;
    backTexRef.current = backTex;

    // G. Create Acrylic and Print Layers Group
    const passGroup = new THREE.Group();
    scene.add(passGroup);

    // Dimension scales: 10 * 5 * 0.47 cm.
    // In our 3D space, we map 1cm to 1.0 units.
    // Card Width = 5.0, Card Height = 10.0, Card Depth = 0.47
    const w = 5.0;
    const h = 10.0;
    const d = thickness;

    // Use a sharp rectangular top face. The real acrylic plate should follow the diecut contour directly,
    // without any rounded-corner smoothing or beveling.
    const shape = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    shape.moveTo(x, y);
    shape.lineTo(x + w, y);
    shape.lineTo(x + w, y + h);
    shape.lineTo(x, y + h);
    shape.closePath();

    // 1. Acrylic Base Mesh
    // The acrylic plate should be treated as a straight swept solid generated from the boundary contour:
    // - top face: the plate face area
    // - side wall: the vertical extrusion of the boundary edges along thickness
    // - no bevel: the manufacturing boundary is kept sharp and square
    const extrudeSettings = {
      steps: 1,
      depth: 1.0,
      bevelEnabled: false,
      bevelThickness: 0,
      bevelSize: 0,
      bevelOffset: 0,
      bevelSegments: 0,
    };

    const acrylicGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    acrylicGeo.center(); // Center geometry around (0,0,0) so front face is at +halfD and back is at -halfD

    // The diecut mask may contain holes (e.g. circular openings). We should respect that in 3D as well.
    // We use the same mask as a cutout alpha on the transparent acrylic body so the interior holes do not appear solid.
    const capMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#ffffff'),
      roughness: 0.02,
      metalness: 0.0,
      transparent: true,
      opacity: 1.0,
      transmission: 0.98,
      ior: 1.49,
      thickness: thickness,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      specularIntensity: 1.0,
      side: THREE.FrontSide,
      depthWrite: false, // Transparent glass shouldn't block depth-test of objects behind it
    });

    const sideMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#ffffff'),
      roughness: 0.9, // Higher roughness for a very frosted / matte laser-cut look!
      metalness: 0.0,
      transparent: true,
      opacity: 1.0,
      transmission: 0.1, // Lower transmission because it's frosted/scattered
      ior: 1.49,
      thickness: thickness,
      clearcoat: 0.1, // Low clearcoat on frosted side
      clearcoatRoughness: 0.6,
      specularIntensity: 0.3,
      side: THREE.FrontSide,
      depthWrite: false,
    });

    const acrylicMesh = new THREE.Mesh(acrylicGeo, [capMat, sideMat]);
    acrylicMesh.receiveShadow = true;
    acrylicMesh.renderOrder = 3;
    acrylicMesh.scale.set(1, 1, thickness); // Scale along Z for thickness
    passGroup.add(acrylicMesh);
    acrylicMeshRef.current = acrylicMesh;

    getDiecutMask().then((maskCanvas) => {
      if (maskCanvas) {
        const diecutTexture = new THREE.CanvasTexture(maskCanvas);
        diecutTexture.colorSpace = THREE.SRGBColorSpace;
        diecutTexture.needsUpdate = true;
        capMat.alphaMap = diecutTexture;
        capMat.alphaTest = 0.1;
        capMat.needsUpdate = true;
        sideMat.alphaMap = diecutTexture;
        sideMat.alphaTest = 0.1;
        sideMat.needsUpdate = true;
      }
    });

    // Helper to assign correct [0, 1] texture coordinates based on X/Y card dimensions
    const assignUVs = (geometry: THREE.BufferGeometry, width: number, height: number, flipU: boolean = false) => {
      const posAttr = geometry.attributes.position;
      if (!posAttr) return;
      const count = posAttr.count;
      const uvs = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const x = posAttr.getX(i);
        const y = posAttr.getY(i);
        // Map x from [-width/2, width/2] to [0, 1]
        let u = (x + width / 2) / width;
        if (flipU) {
          u = 1.0 - u;
        }
        // Map y from [-height/2, height/2] to [0, 1]
        const v = (y + height / 2) / height;
        uvs[i * 2] = u;
        uvs[i * 2 + 1] = v;
      }
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    };

    // 2. Printed Layers Setup
    // Use ShapeGeometry matching the rounded contour shape so all layers are cut by the diecut path!
    const planeGeo = new THREE.ShapeGeometry(shape);
    assignUVs(planeGeo, w, h, false);

    // Create a separate geometry for the back print with flipped U coordinate so the text displays readable (non-mirrored) on the back face
    const backPlaneGeo = new THREE.ShapeGeometry(shape);
    assignUVs(backPlaneGeo, w, h, true);

    // A. Front Print (正面最外层) - faces front
    const frontMat = new THREE.MeshBasicMaterial({
      map: frontTex,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.FrontSide, // Only visible from front
      depthWrite: true, // Write depth to handle spatial occlusion automatically
    });
    const frontMesh = new THREE.Mesh(planeGeo, frontMat);
    frontMesh.renderOrder = 5;
    passGroup.add(frontMesh);
    frontMeshRef.current = frontMesh;

    // B. Front White Backing (正面白墨底) - faces back (looking from inside out) - horizontally mirrored
    const frontBackingMat = new THREE.MeshBasicMaterial({
      map: frontBackingTex,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.BackSide, // Only visible from inside/back
      depthWrite: true,
    });
    const frontBackingMesh = new THREE.Mesh(planeGeo, frontBackingMat);
    frontBackingMesh.renderOrder = 4;
    passGroup.add(frontBackingMesh);
    frontBackingMeshRef.current = frontBackingMesh;

    // C. Middle Print Layer (中层：立绘、底板、阵营) - faces front, printed inside back
    const middleMat = new THREE.MeshBasicMaterial({
      map: middleTex,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.DoubleSide, // Double sided so standing cutout and graphics are visible looking from front or back
      depthWrite: true,
    });
    const middleMesh = new THREE.Mesh(planeGeo, middleMat);
    middleMesh.renderOrder = 2;
    passGroup.add(middleMesh);
    middleMeshRef.current = middleMesh;

    // D. Back Print (背面最外层：商标、背景、条码等) - faces back with flipped U coordinates so back text reads normally
    const backMat = new THREE.MeshBasicMaterial({
      map: backTex,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.BackSide, // Only visible from back
      depthWrite: true,
    });
    const backMesh = new THREE.Mesh(backPlaneGeo, backMat);
    backMesh.renderOrder = 1;
    passGroup.add(backMesh);
    backMeshRef.current = backMesh;

    // Setup positions based on thickness (depth/2)
    const updatePositions = () => {
      const halfD = thickness / 2;

      if (acrylicMeshRef.current) {
        acrylicMeshRef.current.position.set(0, 0, 0);
        acrylicMeshRef.current.scale.set(1, 1, thickness);
      }
      if (frontMeshRef.current) {
        frontMeshRef.current.position.set(0, 0, halfD + 0.006);
      }
      if (frontBackingMeshRef.current) {
        frontBackingMeshRef.current.position.set(0, 0, halfD + 0.002);
      }
      if (middleMeshRef.current) {
        middleMeshRef.current.position.set(0, 0, -halfD + 0.002);
      }
      if (backMeshRef.current) {
        backMeshRef.current.position.set(0, 0, -halfD - 0.006);
      }
    };

    updatePositions();

    // H. Add a subtle base grid and lighting shadow catcher
    const shadowGeo = new THREE.PlaneGeometry(12, 12);
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.15 });
    const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = -6;
    shadowMesh.receiveShadow = true;
    scene.add(shadowMesh);

    // Render loop
    const animate = () => {
      animationFrameIdRef.current = requestAnimationFrame(animate);

      // Light coordinates track camera
      pointLight.position.copy(camera.position);

      if (autoRotateRef.current && passGroup) {
        passGroup.rotation.y += 0.006;
      }

      controls.update();
      renderer.render(scene, camera);
    };

    animate();

    // I. Handle Resize
    const handleResize = () => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    // Save references to allow dynamically changing values on state update
    const cameraRef = { current: camera };

    // Cleanups
    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
      if (controlsRef.current) controlsRef.current.dispose();
      if (rendererRef.current) {
        rendererRef.current.dispose();
        if (container.contains(rendererRef.current.domElement)) {
          container.removeChild(rendererRef.current.domElement);
        }
      }

      // Dispose Geometries and Materials
      acrylicGeo.dispose();
      planeGeo.dispose();
      backPlaneGeo.dispose();
      capMat.dispose();
      sideMat.dispose();
      frontMat.dispose();
      frontBackingMat.dispose();
      middleMat.dispose();
      backMat.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();

      // Dispose textures
      frontTex.dispose();
      frontBackingTex.dispose();
      middleTex.dispose();
      backTex.dispose();
    };
  }, [isPreloading]);

  // 5. Dynamic prop updates (Thickness, Tint) without fully rebuilding Scene
  useEffect(() => {
    if (isPreloading) return;

    // Update positions
    const halfD = thickness / 2;

    if (frontMeshRef.current) {
      frontMeshRef.current.position.set(0, 0, halfD + 0.006);
    }
    if (frontBackingMeshRef.current) {
      frontBackingMeshRef.current.position.set(0, 0, halfD + 0.002);
    }
    if (middleMeshRef.current) {
      middleMeshRef.current.position.set(0, 0, -halfD + 0.002);
    }
    if (backMeshRef.current) {
      backMeshRef.current.position.set(0, 0, -halfD - 0.006);
    }

    // Update Acrylic Core geometry and scale when thickness changes
    if (acrylicMeshRef.current) {
      acrylicMeshRef.current.scale.set(1, 1, thickness);
      // Removed tint updates
    }
  }, [thickness, canvasKey]);

  return (
    <div className="flex flex-col h-full bg-slate-900 rounded-none overflow-hidden text-xs">
      {/* 3D View Container & Canvas Overlay Controls */}
      <div className="relative flex-1 min-h-[460px] bg-radial from-slate-900 to-slate-950 flex items-center justify-center border-b border-slate-800">
        {isPreloading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-md text-blue-400 gap-3">
            <RefreshCw className="w-6 h-6 animate-spin" />
            <span className="font-medium">初始化 3D 物理引擎与预载图层...</span>
          </div>
        )}

        {isUpdatingTextures && !isPreloading && (
          <div className="absolute top-4 left-4 z-10 px-3 py-1.5 rounded-lg bg-slate-950/80 border border-blue-500/30 text-blue-400 flex items-center gap-2 text-[11px] shadow-lg backdrop-blur-xs">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>卡面纹理同步更新中...</span>
          </div>
        )}

        {/* Dynamic Canvas Container for ThreeJS Renderer */}
        <div ref={containerRef} className="w-full h-full absolute inset-0 cursor-grab active:cursor-grabbing" />

        {/* 3D Action floating panel overlay */}
        <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 bg-slate-950/80 p-1.5 rounded-xl border border-slate-800 shadow-xl backdrop-blur-md">
          <button
            onClick={() => setAutoRotate((prev) => !prev)}
            className={`p-2 rounded-lg transition flex items-center gap-1.5 ${
              autoRotate
                ? 'bg-blue-600 text-white shadow'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title={autoRotate ? '停止自动旋转' : '开启自动旋转'}
          >
            <RotateCw className={`w-4 h-4 ${autoRotate ? 'animate-spin [animation-duration:8s]' : ''}`} />
            <span className="text-[10px] font-bold px-0.5">{autoRotate ? '自动旋转中' : '已暂停旋转'}</span>
          </button>
          <button
            onClick={() => {
              if (controlsRef.current) {
                controlsRef.current.reset();
                if (sceneRef.current) sceneRef.current.rotation.set(0, 0, 0);
              }
            }}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            title="重置视角"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition"
            title={isFullscreen ? '退出全屏' : '全屏预览'}
            aria-label={isFullscreen ? '退出全屏' : '全屏预览'}
          >
            {isFullscreen ? <Maximize2 className="w-4 h-4 rotate-180" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>

        {/* Quick Instructions Overlay */}
        <div className="absolute top-4 right-4 text-[11px] bg-slate-950/60 text-slate-400 px-3 py-1.5 rounded-lg border border-slate-800/80 pointer-events-none select-none">
          💡 拖拽进行 3D 旋转 · 滚轮进行缩放
        </div>
      </div>

      {/* 3D Physical Material Controls */}
      <div className="p-4 bg-slate-950/80 border-t border-slate-900 space-y-4">
        {/* Row 1: Grid controls */}
        <div className="grid grid-cols-2 gap-4">
          {/* Acrylic physical thickness */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span className="flex items-center gap-1.5 text-slate-300 font-semibold">
                <Sliders className="w-3.5 h-3.5 text-blue-400" />
                亚克力板材厚度 (cm)
              </span>
              <span className="font-mono text-blue-400 font-bold">{thickness} cm</span>
            </div>
            <input
              type="range"
              min="0.2"
              max="1.2"
              step="0.05"
              value={thickness}
              onChange={(e) => setThickness(parseFloat(e.target.value))}
              className="w-full accent-blue-500 bg-slate-800 h-1 rounded-lg appearance-none cursor-pointer"
            />
          </div>
        </div>

        {/* Row 2: Rotation & Light quick switches */}
        <div className="flex items-center justify-between bg-slate-900/60 border border-slate-800 p-3 rounded-xl gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
              <RotateCw className={`w-4 h-4 ${autoRotate ? 'animate-spin [animation-duration:12s]' : ''}`} />
            </div>
            <div>
              <div className="font-bold text-slate-200">自动旋转展示</div>
              <div className="text-[10px] text-slate-500">开启后亚克力牌将水平匀速旋转展示双面工艺</div>
            </div>
          </div>
          <button
            onClick={() => setAutoRotate((prev) => !prev)}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer select-none ${
              autoRotate
                ? 'bg-red-600/25 hover:bg-red-600/35 text-red-300 border border-red-500/30'
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-900/25'
            }`}
          >
            {autoRotate ? '暂停旋转' : '开始旋转'}
          </button>
        </div>
      </div>
    </div>
  );
};
