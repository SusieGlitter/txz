import React, { useState, useRef, useEffect } from 'react';
import { X, ZoomIn, ZoomOut, Check, Move, Eye, EyeOff, Maximize2, RefreshCw, ArrowRight, ArrowLeft, Crop } from 'lucide-react';

interface ImageCropperModalProps {
  isOpen: boolean;
  onClose: () => void;
  frontPhotoUrl: string;
  cutoutPhotoUrl: string;
  onApplyCropped: (croppedFront: string, croppedCutout: string) => void;
}

export const ImageCropperModal: React.FC<ImageCropperModalProps> = ({
  isOpen,
  onClose,
  frontPhotoUrl,
  cutoutPhotoUrl,
  onApplyCropped,
}) => {
  // Step state: 'align' (Step 1) | 'crop' (Step 2)
  const [step, setStep] = useState<'align' | 'crop'>('align');

  // Step 1: Cutout alignment offsets & scale relative to base photo
  const [cutoutPos, setCutoutPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [cutoutScale, setCutoutScale] = useState<number>(1.0);

  // Blinking effect state for Step 1
  const [isBlinking, setIsBlinking] = useState<boolean>(true);
  const [blinkVisible, setBlinkVisible] = useState<boolean>(true);

  // Step 2: Selection crop box (590 : 1180 aspect ratio frame - 1:2 ratio)
  const [cropBoxScale, setCropBoxScale] = useState<number>(1.0);
  const [cropBoxPos, setCropBoxPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Interaction mode: 'cutout' | 'cropbox'
  const [dragTarget, setDragTarget] = useState<'cutout' | 'cropbox' | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frontImgRef = useRef<HTMLImageElement | null>(null);
  const cutoutImgRef = useRef<HTMLImageElement | null>(null);

  // Helper to get base bounding box for rendering so it fits in canvas
  const getBaseRect = (imgWidth: number, imgHeight: number, cWidth: number, cHeight: number) => {
    const maxWidth = cWidth * 0.9;
    const maxHeight = cHeight * 0.9;
    const scale = Math.min(maxWidth / imgWidth, maxHeight / imgHeight);
    const w = imgWidth * scale;
    const h = imgHeight * scale;
    const x = (cWidth - w) / 2;
    const y = (cHeight - h) / 2;
    return { x, y, w, h, scale };
  };

  // Helper to get crop box rect based on scale and position
  const getCropBoxRect = (cWidth: number, cHeight: number) => {
    const baseW = 250;
    const baseH = 500;
    const w = baseW * cropBoxScale;
    const h = baseH * cropBoxScale;
    const x = (cWidth - w) / 2 + cropBoxPos.x;
    const y = (cHeight - h) / 2 + cropBoxPos.y;
    return { x, y, w, h };
  };

  // Load images when opened & reset step
  useEffect(() => {
    if (!isOpen) return;
    setStep('align');
    setCutoutPos({ x: 0, y: 0 });
    setCutoutScale(1.0);
    setIsBlinking(true);

    if (frontPhotoUrl) {
      const img = new Image();
      img.src = frontPhotoUrl;
      img.onload = () => {
        frontImgRef.current = img;
      };
    } else {
      frontImgRef.current = null;
    }

    if (cutoutPhotoUrl) {
      const cImg = new Image();
      cImg.src = cutoutPhotoUrl;
      cImg.onload = () => {
        cutoutImgRef.current = cImg;
      };
    } else {
      cutoutImgRef.current = null;
    }
  }, [isOpen, frontPhotoUrl, cutoutPhotoUrl]);

  // Blinking Timer (500ms toggle in Step 1)
  useEffect(() => {
    if (!isOpen || step !== 'align' || !isBlinking) {
      setBlinkVisible(true);
      return;
    }
    const timer = setInterval(() => {
      setBlinkVisible((prev) => !prev);
    }, 500);
    return () => clearInterval(timer);
  }, [isOpen, step, isBlinking]);

  // Render Canvas
  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Dark canvas background grid
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid lines for precise alignment
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // 0. Checkerboard grid inside crop box to visualize transparent overflow areas
    const cropBox = getCropBoxRect(canvas.width, canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cropBox.x, cropBox.y, cropBox.w, cropBox.h);
    ctx.clip();

    const tileSize = 12;
    for (let cx = cropBox.x; cx < cropBox.x + cropBox.w; cx += tileSize) {
      for (let cy = cropBox.y; cy < cropBox.y + cropBox.h; cy += tileSize) {
        const isEven = (Math.floor((cx - cropBox.x) / tileSize) + Math.floor((cy - cropBox.y) / tileSize)) % 2 === 0;
        ctx.fillStyle = isEven ? '#1e293b' : '#0f172a';
        ctx.fillRect(cx, cy, tileSize, tileSize);
      }
    }
    ctx.restore();

    // 1. Render Base Photo ("原图")
    if (frontImgRef.current) {
      const img = frontImgRef.current;
      ctx.save();
      const { x: dx, y: dy, w: drawW, h: drawH } = getBaseRect(img.width, img.height, canvas.width, canvas.height);
      ctx.drawImage(img, dx, dy, drawW, drawH);
      ctx.restore();
    }

    // 2. Render Cutout Photo ("抠图") with Blinking & Alignment Offset
    if (cutoutImgRef.current) {
      const cImg = cutoutImgRef.current;
      ctx.save();
      const { w: baseW, h: baseH } = getBaseRect(cImg.width, cImg.height, canvas.width, canvas.height);
      const dx = (canvas.width - baseW) / 2 + cutoutPos.x;
      const dy = (canvas.height - baseH) / 2 + cutoutPos.y;

      const finalW = baseW * cutoutScale;
      const finalH = baseH * cutoutScale;
      const finalX = dx + (baseW - finalW) / 2;
      const finalY = dy + (baseH - finalH) / 2;

      // Opacity during blinking (only in Step 1)
      ctx.globalAlpha = step === 'align' && blinkVisible ? 1.0 : step === 'crop' ? 1.0 : 0.2;
      ctx.drawImage(cImg, finalX, finalY, finalW, finalH);
      ctx.restore();
    }

    // 3. Render Aspect Ratio Selection Crop Frame (590:1180 Frame)
    ctx.save();
    if (step === 'crop') {
      // Darken outside crop frame in Step 2
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(0, 0, canvas.width, cropBox.y);
      ctx.fillRect(0, cropBox.y + cropBox.h, canvas.width, canvas.height - (cropBox.y + cropBox.h));
      ctx.fillRect(0, cropBox.y, cropBox.x, cropBox.h);
      ctx.fillRect(
        cropBox.x + cropBox.w,
        cropBox.y,
        canvas.width - (cropBox.x + cropBox.w),
        cropBox.h
      );

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(cropBox.x, cropBox.y, cropBox.w, cropBox.h);
      ctx.setLineDash([]);

      ctx.fillStyle = '#38bdf8';
      const handleSize = 8;
      ctx.fillRect(cropBox.x - handleSize / 2, cropBox.y - handleSize / 2, handleSize, handleSize);
      ctx.fillRect(
        cropBox.x + cropBox.w - handleSize / 2,
        cropBox.y - handleSize / 2,
        handleSize,
        handleSize
      );
      ctx.fillRect(
        cropBox.x - handleSize / 2,
        cropBox.y + cropBox.h - handleSize / 2,
        handleSize,
        handleSize
      );
      ctx.fillRect(
        cropBox.x + cropBox.w - handleSize / 2,
        cropBox.y + cropBox.h - handleSize / 2,
        handleSize,
        handleSize
      );

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('通行证卡面裁切框 (590:1180)', cropBox.x + 8, cropBox.y + 18);
    } else {
      // In Step 1, render subtle preview outline for reference
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(cropBox.x, cropBox.y, cropBox.w, cropBox.h);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.6)';
      ctx.font = '10px sans-serif';
      ctx.fillText('裁切框预览位置', cropBox.x + 6, cropBox.y + 14);
    }

    ctx.restore();
  }, [isOpen, step, cutoutPos, cutoutScale, blinkVisible, cropBoxScale, cropBoxPos]);

  if (!isOpen) return null;

  // Mouse Drag Handlers based on Step
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (step === 'align') {
      // Step 1: Mouse drags Cutout image alignment
      setDragTarget('cutout');
      setDragStart({ x: clickX - cutoutPos.x, y: clickY - cutoutPos.y });
    } else {
      // Step 2: Mouse drags Crop box position
      setDragTarget('cropbox');
      setDragStart({ x: clickX - cropBoxPos.x, y: clickY - cropBoxPos.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragTarget || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const moveX = e.clientX - rect.left;
    const moveY = e.clientY - rect.top;

    if (dragTarget === 'cutout') {
      setCutoutPos({
        x: moveX - dragStart.x,
        y: moveY - dragStart.y,
      });
    } else if (dragTarget === 'cropbox') {
      const cropBox = getCropBoxRect(canvasRef.current.width, canvasRef.current.height);
      // Let's just constrain the dragging so cropBox doesn't completely leave canvas
      // But cropBoxPos is the center offset.
      const newX = moveX - dragStart.x;
      const newY = moveY - dragStart.y;
      setCropBoxPos({ x: newX, y: newY });
    }
  };

  const handleMouseUp = () => setDragTarget(null);

  // 短边对齐 (Short Edge Alignment)
  const handleShortEdgeFit = () => {
    if (!cutoutImgRef.current || !canvasRef.current) return;
    const cImg = cutoutImgRef.current;
    const cropBox = getCropBoxRect(canvasRef.current.width, canvasRef.current.height);
    const { w: baseW, h: baseH } = getBaseRect(cImg.width, cImg.height, canvasRef.current.width, canvasRef.current.height);

    const imgRatio = baseW / baseH;
    const boxRatio = cropBox.w / cropBox.h;

    if (imgRatio > boxRatio) {
      const targetScale = cropBox.h / baseH;
      setCutoutScale(targetScale);
    } else {
      const targetScale = cropBox.w / baseW;
      setCutoutScale(targetScale);
    }
    setCutoutPos({ x: 0, y: 0 });
  };

  // Reset Crop Box
  const handleResetCropBox = () => {
    setCropBoxScale(1.0);
    setCropBoxPos({ x: 0, y: 0 });
  };

  // Confirm Alignment & Crop Output (Supports overflow with transparent fill)
  const handleSave = () => {
    const targetW = 590;
    const targetH = 1180;
    const wsCanvas = canvasRef.current;
    if (!wsCanvas) return;

    const cropBox = getCropBoxRect(wsCanvas.width, wsCanvas.height);

    // Scale from workspace cropBox coordinate space to target 590x1180 output canvas
    const scaleFactor = targetW / cropBox.w;

    // 1. Output Front Photo
    const frontCanvas = document.createElement('canvas');
    frontCanvas.width = targetW;
    frontCanvas.height = targetH;
    const fCtx = frontCanvas.getContext('2d');

    if (fCtx && frontImgRef.current) {
      fCtx.clearRect(0, 0, targetW, targetH);
      const img = frontImgRef.current;
      const { x: dx, y: dy, w: drawW, h: drawH } = getBaseRect(img.width, img.height, wsCanvas.width, wsCanvas.height);

      const outX = (dx - cropBox.x) * scaleFactor;
      const outY = (dy - cropBox.y) * scaleFactor;
      const outW = drawW * scaleFactor;
      const outH = drawH * scaleFactor;

      fCtx.drawImage(img, outX, outY, outW, outH);
    }

    // 2. Output Cutout Photo
    const cutoutCanvas = document.createElement('canvas');
    cutoutCanvas.width = targetW;
    cutoutCanvas.height = targetH;
    const cCtx = cutoutCanvas.getContext('2d');

    if (cCtx && (cutoutImgRef.current || frontImgRef.current)) {
      cCtx.clearRect(0, 0, targetW, targetH);
      const activeImg = cutoutImgRef.current || frontImgRef.current;

      if (activeImg) {
        const { w: baseW, h: baseH } = getBaseRect(activeImg.width, activeImg.height, wsCanvas.width, wsCanvas.height);
        const dx = (wsCanvas.width - baseW) / 2 + cutoutPos.x;
        const dy = (wsCanvas.height - baseH) / 2 + cutoutPos.y;

        const finalW = baseW * cutoutScale;
        const finalH = baseH * cutoutScale;
        const finalX = dx + (baseW - finalW) / 2;
        const finalY = dy + (baseH - finalH) / 2;

        const outX = (finalX - cropBox.x) * scaleFactor;
        const outY = (finalY - cropBox.y) * scaleFactor;
        const outW = finalW * scaleFactor;
        const outH = finalH * scaleFactor;

        cCtx.drawImage(activeImg, outX, outY, outW, outH);
      }
    }

    const croppedFrontData = frontCanvas.toDataURL('image/png');
    const croppedCutoutData = cutoutCanvas.toDataURL('image/png');

    onApplyCropped(croppedFrontData, croppedCutoutData);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
      <div className="relative w-full max-w-3xl rounded-2xl bg-slate-900 p-6 border border-slate-800 shadow-2xl text-white space-y-4">
        {/* Header with 2-Step Nav */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-3">
          <div className="flex items-center gap-2">
            <Move className="w-5 h-5 text-blue-400" />
            <h3 className="text-base font-bold">图像预处理与裁切 (Photo Alignment & Crop)</h3>
          </div>

          {/* Stepper Tabs */}
          <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs font-bold">
            <button
              onClick={() => setStep('align')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition ${
                step === 'align'
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>1. 原图与抠图对齐</span>
            </button>
            <div className="w-3 h-px bg-slate-700 mx-1" />
            <button
              onClick={() => setStep('crop')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition ${
                step === 'crop'
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Crop className="w-3.5 h-3.5" />
              <span>2. 框选裁切范围</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition self-end sm:self-auto"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dynamic Tip & Toolbar Header per Step */}
        {step === 'align' ? (
          <div className="flex flex-wrap items-center justify-between bg-slate-950 px-4 py-2 rounded-xl border border-slate-800 text-xs gap-2">
            <span className="text-slate-300 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping shrink-0" />
              <strong>步骤一：原图与抠图对齐。</strong>按住鼠标拖动抠图，调整缩放使其与底图吻合。
            </span>
            <button
              onClick={() => setIsBlinking((b) => !b)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-bold transition ${
                isBlinking
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {isBlinking ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              {isBlinking ? '闪烁观察中' : '闪烁已暂停'}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between bg-slate-950 px-4 py-2 rounded-xl border border-slate-800 text-xs gap-2">
            <span className="text-slate-300 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />
              <strong>步骤二：框选通行证卡面区域。</strong>拖动蓝框确定 590:1180 范围，超出区域透明填充。
            </span>
            <button
              onClick={handleResetCropBox}
              className="flex items-center gap-1 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition text-xs"
            >
              <RefreshCw className="w-3 h-3 text-slate-400" />
              重置框选
            </button>
          </div>
        )}

        {/* Workspace Canvas */}
        <div className="flex justify-center overflow-hidden rounded-xl bg-slate-950 p-3 border border-slate-800 select-none">
          <canvas
            ref={canvasRef}
            width={480}
            height={520}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            className="cursor-move rounded-lg border border-slate-800 shadow-inner"
          />
        </div>

        {/* Step-Specific Controls */}
        {step === 'align' ? (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-slate-800/60 p-3 rounded-xl border border-slate-800 text-xs">
            {/* Zoom Slider */}
            <div className="flex items-center gap-2 sm:col-span-2">
              <ZoomOut className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="text-slate-400 text-[11px] shrink-0">抠图缩放:</span>
              <input
                type="range"
                min="0.4"
                max="2.2"
                step="0.02"
                value={cutoutScale}
                onChange={(e) => setCutoutScale(parseFloat(e.target.value))}
                className="w-full accent-blue-500 cursor-pointer"
              />
              <ZoomIn className="w-4 h-4 text-slate-400 shrink-0" />
            </div>

            {/* Short edge fit button */}
            <button
              onClick={handleShortEdgeFit}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 rounded-xl font-medium transition"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              短边对齐
            </button>

            {/* Reset position button */}
            <button
              onClick={() => {
                setCutoutPos({ x: 0, y: 0 });
                setCutoutScale(1.0);
              }}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl transition"
            >
              <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
              重置位移
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-slate-800/60 p-3 rounded-xl border border-slate-800 text-xs">
            {/* Crop Box Zoom Slider */}
            <div className="flex items-center gap-2 sm:col-span-3">
              <ZoomOut className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="text-slate-400 text-[11px] shrink-0">裁剪框缩放:</span>
              <input
                type="range"
                min="0.4"
                max="2.0"
                step="0.02"
                value={cropBoxScale}
                onChange={(e) => setCropBoxScale(parseFloat(e.target.value))}
                className="w-full accent-emerald-500 cursor-pointer"
              />
              <ZoomIn className="w-4 h-4 text-slate-400 shrink-0" />
            </div>

            <div className="flex items-center justify-end">
              <button
                onClick={handleResetCropBox}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition font-medium"
              >
                默认居中
              </button>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-between border-t border-slate-800 pt-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition text-sm"
          >
            取消
          </button>

          <div className="flex items-center gap-3">
            {step === 'crop' && (
              <button
                onClick={() => setStep('align')}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-sm transition"
              >
                <ArrowLeft className="w-4 h-4" />
                上一步：调整对齐
              </button>
            )}

            {step === 'align' ? (
              <button
                onClick={() => setStep('crop')}
                className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition shadow-lg shadow-blue-500/25"
              >
                <span>下一步：框选裁切</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleSave}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition shadow-lg shadow-emerald-500/25"
              >
                <Check className="w-4 h-4" />
                完成裁切并应用 (Apply Crop)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
