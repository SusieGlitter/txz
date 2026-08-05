const fs = require('fs');
let content = fs.readFileSync('src/utils/passRenderer.ts', 'utf8');

content = content.replace(/await drawGradientStripe\(ctx, baseColor \|\| '#000000', false\);/, 'await drawGradientStripe(ctx, false, layers);');
content = content.replace(/await drawGradientStripe\(ctx, info\.base_color \|\| '#000000', true\);/, 'await drawGradientStripe(ctx, true, layers);');
content = content.replace(/await drawGradientStripe\(offCtx, '#000000', false\);/, 'await drawGradientStripe(offCtx, false, layers);');

const oldFuncRegex = /async function drawGradientStripe\([\s\S]*?\}\s*\}/;
const newFunc = `async function drawGradientStripe(ctx: CanvasRenderingContext2D, isBack: boolean, layers?: LayerVisibilityConfig) {
  if (layers?.borderOverlay === false) return;
  const assetName = isBack ? './psd_assets/背面__装饰__渐变条纹.png' : './psd_assets/正面__装饰图案__渐变条纹.png';
  const img = imageCache.get(assetName) || await loadImage(assetName);
  if (isImageValid(img)) {
    ctx.drawImage(img, isBack ? 483 : 95, 684, 13, 496);
  }
}`;

content = content.replace(oldFuncRegex, newFunc);
fs.writeFileSync('src/utils/passRenderer.ts', content);
