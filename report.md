# 亚克力折射实现心得

## 目标

通行证不是一张带透明度的平面贴图，而是一个有厚度的亚克力印刷品。渲染时需要同时满足：

- 正面外侧和背面外侧位于各自物理表面。
- 内侧印刷可以透过亚克力看到。
- 正反面不能因为双面材质而出现镜像泄漏。
- 接近侧视时仍然连续显示侧壁和正确的印刷层顺序。
- 折射不能绕过深度关系，把内容错误地绘制到另一面。

## 当前模型

卡片沿 Z 轴有四个印刷层：

1. 正面外侧：`frontOuter`
2. 正面内侧白墨背衬：`frontInner`
3. 背面内侧：`backInner`，来源是 `middleCanvasRef`
4. 背面外侧：`backOuter`

四层都使用真实的 Z 位置和单面材质。正面外侧、正面内侧、背面外侧使用各自朝向表面的 `FrontSide` / `BackSide`，避免从反面读取镜像纹理。

## 折射 Pass

折射使用两个离屏缓冲：

- `envRT`：只渲染内侧印刷层，作为亚克力内部内容的采样源。
- `backfaceRT`：渲染亚克力背向观察者的一侧，并把观察空间法线编码到 RGB。

屏幕绘制时按以下顺序执行：

1. 渲染内侧印刷到 `envRT`。
2. 渲染亚克力背面法线到 `backfaceRT`。
3. 在屏幕上绘制内侧印刷。
4. 使用入射面法线、背面法线、PMMA 折射率 `1.49` 和厚度计算折射采样。
5. 绘制折射亚克力。
6. 绘制外侧印刷，使外侧图案保持清晰并位于物理外表面。

这样做的关键是：折射只改变亚克力内部内容的采样位置，不拥有最终的印刷层绘制权。外侧图案仍由深度和单面材质控制。

### 关键实现代码

桌面 3D 预览的 Pass 顺序：

```ts
// A: 内侧印刷作为折射采样源
acrylicMesh.visible = false;
outerPrints.forEach((mesh) => (mesh.visible = false));
innerPrints.forEach((mesh) => (mesh.visible = true));
renderer.setRenderTarget(envRT);
renderer.clear();
renderer.render(scene, camera);

// B: 亚克力背面法线
innerPrints.forEach((mesh) => (mesh.visible = false));
acrylicMesh.visible = true;
acrylicMesh.material = backfaceMaterial;
renderer.setRenderTarget(backfaceRT);
renderer.clear();
renderer.render(scene, camera);

// C: 内侧印刷 -> 折射亚克力 -> 外侧印刷
renderer.setRenderTarget(null);
renderer.clear();
renderer.render(scene, camera);
acrylicMesh.material = refractionMats;
renderer.render(scene, camera);
acrylicMesh.visible = false;
outerPrints.forEach((mesh) => (mesh.visible = true));
renderer.render(scene, camera);
```

折射 shader 的核心是 Snell 折射和侧面散射：

```glsl
vec3 refracted = refract(incident, normal, 1.0 / refractIor);
vec2 viewDelta =
  (refracted.xy / refractedZ - incident.xy / incidentZ) * slabThickness;
vec2 disp = 0.5 * projectionScale * viewDelta / abs(vViewPosition.z);

float s = frost * (12.0 / max(resolution.x, resolution.y));
vec3 color = (
  texture2D(envTex, base + o1).rgb +
  texture2D(envTex, base + o2).rgb +
  texture2D(envTex, base - o1).rgb +
  texture2D(envTex, base - o2).rgb
) * 0.25;
```

顶面/底面使用 `frost: 0`，侧面使用更高的 `frost`，所以正面保持透亮，侧壁才会出现可见的散射模糊。

## 侧面材质

侧壁使用独立的磨砂材质，保留少量透明度、粗糙度、噪声 bump 和轻微散射。磨砂强度不能过高，否则侧视时会把内部印刷完全洗掉；当前参数只增加很小的颗粒感。

## 背面内侧专用边框

背面内侧不直接复用背面外侧边框，而是从正面外侧边框生成独立模板：

- 测量 `中间__精一底板.png` 的非透明高度。
- 以画布底边为基准，左半边删除距离底边小于该高度的内容。
- 右半边删除距离底边小于该高度一半的内容。
- 模板先绘制，再绘制人物、精一底板和阵营图标，因此边框属于该层最底部。
- 背面内侧变体不绘制彩条。

模板会缓存为独立 Canvas，并可从调试面板下载为 PNG。

## AR 识别

AR 摄像头和 AprilTag 主流程保持主分支结构：

- 优先请求后置摄像头，失败时回退默认摄像头。
- 等待视频首帧数据可用后再创建位姿相机。
- 预加载 AprilTag WASM。
- 检测任务禁止重入，避免多个异步检测同时写 WASM 图像缓冲。
- 位姿位置、旋转和缩放不再做时间平滑，直接跟随最新识别结果。

## 局限

当前折射是屏幕空间近似，不是光线追踪：它适合平行亚克力板和实时预览，但不能完整模拟多次内部反射、色散、真实环境反射或复杂曲面。对于本项目的平面通行证，这种方案在性能、可控性和印刷层遮挡之间取得了较好的平衡。
