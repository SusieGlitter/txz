# -*- coding: utf-8 -*-
"""验证 qrPose.ts 的位姿估算是否存在 CV->Three.js 坐标转换缺失。

场景：二维码在 Three.js 相机前方 (z<0)，法线朝向相机 (z>0)。
用与 qrPose.ts 相同的 DLT 算法估算位姿，检查恢复的位姿是否与真实值一致。
"""
import math

def solve_homography_dlt(src, dst):
    rows, rhs = [], []
    for (X, Y), (u, v) in zip(src, dst):
        rows.append([-X, -Y, -1, 0, 0, 0, u*X, u*Y]); rhs.append(-u)
        rows.append([0, 0, 0, -X, -Y, -1, v*X, v*Y]); rhs.append(-v)
    n = 8
    N = [[0.0]*n for _ in range(n)]
    c = [0.0]*n
    for i in range(n):
        for j in range(n):
            N[i][j] = sum(rows[k][i]*rows[k][j] for k in range(len(rows)))
        c[i] = sum(rows[k][i]*rhs[k] for k in range(len(rows)))
    M = [row + [c[i]] for i, row in enumerate(N)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[pivot][col]) < 1e-10: return None
        M[col], M[pivot] = M[pivot], M[col]
        for r in range(col+1, n):
            f = M[r][col]/M[col][col]
            for c2 in range(col, n+1): M[r][c2] -= f*M[col][c2]
    h = [0.0]*n
    for r in range(n-1, -1, -1):
        s = M[r][n]
        for c2 in range(r+1, n): s -= M[r][c2]*h[c2]
        h[r] = s/M[r][r]
    return h + [1.0]

def est_pose(corners, iw, ih, s, fov_y_deg):
    src = [[-s/2,-s/2],[s/2,-s/2],[s/2,s/2],[-s/2,s/2]]
    dst = [[p[0],p[1]] for p in corners]
    h = solve_homography_dlt(src, dst)
    if not h: return None
    cx, cy = iw/2, ih/2
    f = (ih/2)/math.tan(math.radians(fov_y_deg)/2)
    g = [h[0]/f - cx*h[6]/f, h[1]/f - cx*h[7]/f, h[2]/f - cx*h[8]/f,
         h[3]/f - cy*h[6]/f, h[4]/f - cy*h[7]/f, h[5]/f - cy*h[8]/f,
         h[6], h[7], h[8]]
    def v3(x,y,z): return [x,y,z]
    r1 = v3(g[0],g[3],g[6]); r2 = v3(g[1],g[4],g[7]); t = v3(g[2],g[5],g[8])
    def norm(v): return math.sqrt(sum(a*a for a in v))
    def scale(v,k): return [a*k for a in v]
    def add(a,b): return [a[i]+b[i] for i in range(3)]
    def sub(a,b): return [a[i]-b[i] for i in range(3)]
    def cross(a,b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    def dot(a,b): return sum(a[i]*b[i] for i in range(3))
    sc = (norm(r1)+norm(r2))/2
    r1 = scale(r1, 1/sc); r2 = scale(r2, 1/sc); t = scale(t, 1/sc)
    # ---- 现有代码: 无 CV->Three 转换 ----
    if t[2] < 0:  # 确保 t.z>0 (CV 前方)
        r1=scale(r1,-1); r2=scale(r2,-1); t=scale(t,-1)
    e1 = scale(r1, 1/norm(r1))
    e2 = sub(r2, scale(e1, dot(r2,e1)))
    e2 = scale(e2, 1/norm(e2))
    e3 = cross(e1,e2)
    e3 = scale(e3, 1/norm(e3))
    if e3[2] < 0: e3 = scale(e3, -1)
    return {'t': t, 'e1': e1, 'e2': e2, 'e3': e3}

def est_pose_fixed(corners, iw, ih, s, fov_y_deg):
    src = [[-s/2,-s/2],[s/2,-s/2],[s/2,s/2],[-s/2,s/2]]
    dst = [[p[0],p[1]] for p in corners]
    h = solve_homography_dlt(src, dst)
    if not h: return None
    cx, cy = iw/2, ih/2
    f = (ih/2)/math.tan(math.radians(fov_y_deg)/2)
    g = [h[0]/f - cx*h[6]/f, h[1]/f - cx*h[7]/f, h[2]/f - cx*h[8]/f,
         h[3]/f - cy*h[6]/f, h[4]/f - cy*h[7]/f, h[5]/f - cy*h[8]/f,
         h[6], h[7], h[8]]
    def v3(x,y,z): return [x,y,z]
    r1 = v3(g[0],g[3],g[6]); r2 = v3(g[1],g[4],g[7]); t = v3(g[2],g[5],g[8])
    def norm(v): return math.sqrt(sum(a*a for a in v))
    def scale(v,k): return [a*k for a in v]
    def sub(a,b): return [a[i]-b[i] for i in range(3)]
    def cross(a,b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    def dot(a,b): return sum(a[i]*b[i] for i in range(3))
    # ---- 修复: CV(图像y向下,+Z向前) -> Three.js(+Y向上,-Z向前) ----
    def flip(v): return [v[0], -v[1], -v[2]]
    r1 = flip(r1); r2 = flip(r2); t = flip(t)
    sc = (norm(r1)+norm(r2))/2
    r1 = scale(r1, 1/sc); r2 = scale(r2, 1/sc); t = scale(t, 1/sc)
    if t[2] > 0:  # Three.js 前方是 -Z, 应保证 t.z<0
        r1=scale(r1,-1); r2=scale(r2,-1); t=scale(t,-1)
    e1 = scale(r1, 1/norm(r1))
    e2 = sub(r2, scale(e1, dot(r2,e1)))
    e2 = scale(e2, 1/norm(e2))
    e3 = cross(e1,e2)
    e3 = scale(e3, 1/norm(e3))
    if e3[2] < 0: e3 = scale(e3, -1)  # 法线朝向相机(+Z)
    return {'t': t, 'e1': e1, 'e2': e2, 'e3': e3}

def project(p3, f, cx, cy):
    x,y,z = p3
    return (f*x/(-z) + cx, cy + f*y/z)  # Three.js -> 图像(v 向下)

def test(name, t3, n3, fov=45, s=5.0):
    iw, ih = 1280, 720
    cx, cy = iw/2, ih/2
    f = (ih/2)/math.tan(math.radians(fov)/2)
    # 二维码平面: 局部 X(右) x3, 局部 Y(上,在平面内) y3
    x3 = [n3[1]*0 - n3[2]*0, 0, 0]  # placeholder
    # 构造平面内正交基: y3 大致=世界up投影到平面, x3=叉积
    # n3 已是单位向量(平面法线,朝相机), 平面内局部+X、+Y:
    up = [0,1,0]
    x3 = [up[1]*n3[2]-up[2]*n3[1], up[2]*n3[0]-up[0]*n3[2], up[0]*n3[1]-up[1]*n3[0]]
    xn = math.sqrt(sum(a*a for a in x3))
    if xn < 1e-6:
        x3 = [1,0,0]
    else:
        x3 = [a/xn for a in x3]
    y3 = [n3[1]*x3[2]-n3[2]*x3[1], n3[2]*x3[0]-n3[0]*x3[2], n3[0]*x3[1]-n3[1]*x3[0]]
    half = s/2
    corners3 = [
        [t3[i] - half*x3[i] - half*y3[i] for i in range(3)],  # TL
        [t3[i] + half*x3[i] - half*y3[i] for i in range(3)],  # TR
        [t3[i] + half*x3[i] + half*y3[i] for i in range(3)],  # BR
        [t3[i] - half*x3[i] + half*y3[i] for i in range(3)],  # BL
    ]
    img_corners = [project(p, f, cx, cy) for p in corners3]
    print(f'--- {name} ---')
    print(f'  真实位置  t3 = {[round(a,2) for a in t3]}, 法线 n3 = {[round(a,2) for a in n3]}')
    print(f'  角点投影 = {[ [round(u),round(v)] for u,v in img_corners]}')
    r_old = est_pose(img_corners, iw, ih, s, fov)
    r_new = est_pose_fixed(img_corners, iw, ih, s, fov)
    if r_old:
        print(f'  旧代码: t={[round(a,2) for a in r_old["t"]]} e3={[round(a,2) for a in r_old["e3"]]}')
    if r_new:
        print(f'  修复后: t={[round(a,2) for a in r_new["t"]]} e3={[round(a,2) for a in r_new["e3"]]}')
    # 验证
    if r_new:
        err_t = math.sqrt(sum((a-b)**2 for a,b in zip(r_new['t'], t3)))
        ok = err_t < 1.0
        print(f'  位置误差={err_t:.3f} cm  -> {"OK" if ok else "FAIL"}')

test('正前方, 法线朝相机', [0, 0, -40], [0, 0, 1])
test('偏右下, 法线略朝上',  [12, 8, -35], [0, 0.25, 0.97])
test('偏左上, 法线带侧倾',  [-15, -6, -30], [-0.3, 0.4, 0.87])
test('较近',               [3, 2, -15], [0, 0.2, 0.98])
