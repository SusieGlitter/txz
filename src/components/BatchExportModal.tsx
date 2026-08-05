import React, { useState } from 'react';
import { X, Download, Archive, CheckSquare, Square, Loader2, Layers } from 'lucide-react';
import JSZip from 'jszip';
import { CharacterRecord, E1Options, PassCardInfo } from '../types';
import {
  renderFrontCard,
  renderBackCard,
  renderWhiteCard,
  renderDiecutCard,
  loadImage,
  preloadPsdAssets,
  CARD_WIDTH,
  CARD_HEIGHT,
} from '../utils/passRenderer';

interface BatchExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  characters: CharacterRecord[];
  currentInfo: PassCardInfo;
  e1Opts: E1Options;
  frontPhotoUrl: string;
  cutoutPhotoUrl: string;
  customIconUrl: string;
}

export const BatchExportModal: React.FC<BatchExportModalProps> = ({
  isOpen,
  onClose,
  characters,
  currentInfo,
  e1Opts,
  frontPhotoUrl,
  cutoutPhotoUrl,
  customIconUrl,
}) => {
  const [selectedIds, setSelectedIds] = useState<string[]>(
    characters.map((c) => c.id)
  );
  const [exportKinds, setExportKinds] = useState<{
    front: boolean;
    back: boolean;
    white: boolean;
    diecut: boolean;
  }>({
    front: true,
    back: true,
    white: true,
    diecut: true,
  });

  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');

  if (!isOpen) return null;

  const toggleSelectAll = () => {
    if (selectedIds.length === characters.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(characters.map((c) => c.id));
    }
  };

  const toggleSelect = (id: string) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((item) => item !== id));
    } else {
      setSelectedIds([...selectedIds, id]);
    }
  };

  const handleStartBatchExport = async () => {
    if (selectedIds.length === 0) {
      alert('请至少选择一名角色或数据记录进行导出！');
      return;
    }

    setIsGenerating(true);
    setProgressMsg('正在准备资源...');

    try {
      const zip = new JSZip();
      const canvas = document.createElement('canvas');
      canvas.width = CARD_WIDTH;
      canvas.height = CARD_HEIGHT;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        throw new Error('无法创建 Canvas 2D 绘图上下文');
      }

      const img1Obj = frontPhotoUrl ? await loadImage(frontPhotoUrl) : null;
      const cutoutObj = cutoutPhotoUrl ? await loadImage(cutoutPhotoUrl) : null;
      const customIconObj = customIconUrl ? await loadImage(customIconUrl) : null;

      const targetChars = characters.filter((c) => selectedIds.includes(c.id));

      for (let i = 0; i < targetChars.length; i++) {
        const char = targetChars[i];
        const folderName = `${char.english_name || char.id}_${char.chinese_name || ''}`.replace(/[\\/:*?"<>|]/g, '');
        const folder = zip.folder(folderName) || zip;

        const info: PassCardInfo = {
          chinese_name: char.chinese_name,
          english_name: char.english_name,
          english_name2: char.english_name2 || '',
          id: char.id,
          profession: char.profession,
          profession_en: char.profession_en,
          barcode_text: char.barcode_text || char.english_name || char.id,
          back_color: char.back_color || '#0d1b2a',
          show_icon: char.show_icon !== false,
          faction: char.faction || '',
        };

        setProgressMsg(`[${i + 1}/${targetChars.length}] 正在生成 ${char.english_name} 通行证...`);

        // 1. 正面.png
        if (exportKinds.front) {
          ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
          await renderFrontCard(ctx, info, img1Obj, e1Opts, customIconObj, undefined, cutoutObj);
          const dataUrl = canvas.toDataURL('image/png');
          folder.file('正面.png', dataUrl.split(',')[1], { base64: true });
        }

        // 2. 背面.png
        if (exportKinds.back) {
          ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
          await renderBackCard(ctx, info, cutoutObj, e1Opts);
          const dataUrl = canvas.toDataURL('image/png');
          folder.file('背面.png', dataUrl.split(',')[1], { base64: true });
        }

        // 3. 白墨.png
        if (exportKinds.white) {
          ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
          await renderWhiteCard(ctx, info, cutoutObj, e1Opts, img1Obj, customIconObj);
          const dataUrl = canvas.toDataURL('image/png');
          folder.file('白墨.png', dataUrl.split(',')[1], { base64: true });
        }

        // 4. 刀模.png
        if (exportKinds.diecut) {
          ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
          await renderDiecutCard(ctx);
          const dataUrl = canvas.toDataURL('image/png');
          folder.file('刀模.png', dataUrl.split(',')[1], { base64: true });
        }

        // Yield execution loop slightly
        await new Promise((r) => setTimeout(r, 20));
      }

      setProgressMsg('正在打包 ZIP 压缩包...');
      const blob = await zip.generateAsync({ type: 'blob' });

      // Trigger File Download
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `通行证批量设计导出_${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(link.href);

      setProgressMsg('导出成功！');
      setTimeout(() => {
        setIsGenerating(false);
        onClose();
      }, 1000);
    } catch (err: any) {
      console.error(err);
      alert('批量生成过程中发生错误: ' + err.message);
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl rounded-2xl bg-slate-900 p-6 border border-slate-800 shadow-2xl text-white">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Archive className="w-5 h-5 text-purple-400" />
            <h3 className="text-lg font-bold">通行证批量打包与导出</h3>
          </div>
          <button
            onClick={onClose}
            disabled={isGenerating}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Options */}
        <div className="my-4 space-y-4">
          <div className="bg-slate-800/40 p-3 rounded-xl border border-slate-800">
            <h4 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
              <Layers className="w-4 h-4 text-purple-400" /> 选择输出版面文件:
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              {[
                { key: 'front', label: '正面' },
                { key: 'back', label: '背面' },
                { key: 'white', label: '白墨' },
                { key: 'diecut', label: '刀模' },
              ].map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center gap-2 bg-slate-900/60 p-2.5 rounded-lg border border-slate-700/50 cursor-pointer hover:bg-slate-800/80 transition"
                >
                  <input
                    type="checkbox"
                    checked={exportKinds[key as keyof typeof exportKinds]}
                    onChange={(e) =>
                      setExportKinds({
                        ...exportKinds,
                        [key]: e.target.checked,
                      })
                    }
                    className="accent-purple-500 rounded"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Character Selection */}
          <div className="bg-slate-800/40 p-3 rounded-xl border border-slate-800">
            <div className="flex justify-between items-center mb-2">
              <h4 className="text-sm font-semibold text-slate-300">
                选择打包角色数据 ({selectedIds.length} / {characters.length}):
              </h4>
              <button
                onClick={toggleSelectAll}
                className="text-xs text-purple-400 hover:underline flex items-center gap-1"
              >
                {selectedIds.length === characters.length ? (
                  <>
                    <CheckSquare className="w-3.5 h-3.5" /> 取消全选
                  </>
                ) : (
                  <>
                    <Square className="w-3.5 h-3.5" /> 全选角色
                  </>
                )}
              </button>
            </div>

            <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 text-xs">
              {characters.map((char, idx) => {
                const isSelected = selectedIds.includes(char.id);
                return (
                  <div
                    key={`${char.id}-${char.chinese_name}-${idx}`}
                    onClick={() => toggleSelect(char.id)}
                    className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition border ${
                      isSelected
                        ? 'bg-purple-950/40 border-purple-500/50 text-purple-200'
                        : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:bg-slate-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center ${
                          isSelected
                            ? 'bg-purple-600 border-purple-500 text-white'
                            : 'border-slate-600'
                        }`}
                      >
                        {isSelected && <CheckSquare className="w-3 h-3" />}
                      </div>
                      <span className="font-medium text-white">
                        {char.chinese_name || char.english_name}
                      </span>
                      <span className="text-slate-500">
                        ({char.english_name})
                      </span>
                    </div>
                    <span className="font-mono text-slate-500">{char.id}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Progress indicator */}
        {isGenerating && (
          <div className="my-3 flex items-center gap-3 p-3 bg-purple-950/50 border border-purple-800/50 rounded-xl text-purple-200 text-xs">
            <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
            <span>{progressMsg}</span>
          </div>
        )}

        {/* Footer Actions */}
        <div className="mt-4 flex justify-end gap-3 border-t border-slate-800 pt-4">
          <button
            onClick={onClose}
            disabled={isGenerating}
            className="px-4 py-2 rounded-xl text-slate-300 hover:bg-slate-800 transition text-sm disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleStartBatchExport}
            disabled={isGenerating || selectedIds.length === 0}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-medium text-sm transition shadow-lg shadow-purple-500/25 disabled:opacity-50"
          >
            {isGenerating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            打包生成并下载 ZIP
          </button>
        </div>
      </div>
    </div>
  );
};
