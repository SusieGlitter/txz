# -*- coding: utf-8 -*-
"""验证：二维码平放桌面(法线=世界+Y)时, 位姿估算给出的法线朝向。
当前代码用 e3.z<0 翻转(强制法线朝 +Z), 对"桌面平放"场景会把卡片轴线拉向相机。
正确做法: 法线应朝向相机半球 -> 用 dot(e3, dirQR->camera)>0 判定。
"""
import math

def solve_homography_dlt(src, dst):
    rows, rhs = [], []
    for (X, Y), (u, v) in zip(src, dst):
        rows.append([-X, -Y, -1, 0, 0, 0, u*X, u*Y]); rhs.append(-u)
        rows.append([0, 0, 0, -X, -Y, -1, v*X, v*Y]); rhs.append(-v)
    n = 8
    N = [[0.0]*n for _ in range(n)]; c = [0.0]*n
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

def decompose(corners, iw, ih, s, fov_y_deg, chirality):
    src = [[-s/2,-s/2],[s/2,-s/2],[s/2,s/2],[-s/2,s/2]]
    dst = [[p[0],p[1]] for p in corners]
    h = solve_homography_dlt(src, dst)
    if not h: return None
    cx, cy = iw/2, ih/2
    f = (ih/2)/math.tan(math.radians(fov_y_deg)/2)
    g = [h[0]/f - cx*h[6]/f, h[1]/f - cx*h[7]/f, h[2]/f - cx*h[8]/f,
         h[3]/f - cy*h[6]/f, h[4]/f - cy*h[7]/f, h[5]/f - cy*h[8]/f,
         h[6], h[7], h[8]]
    r1 = [g[0],g[3],g[6]]; r2 = [g[1],g[4],g[7]]; t = [g[2],g[5],g[8]]
    def norm(v): return math.sqrt(sum(a*a for a in v))
    def scale(v,k): return [a*k for a in v]
    def sub(a,b): return [a[i]-b[i] for i in range(3)]
    def cross(a,b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    def dot(a,b): return sum(a[i]*b[i] for i in range(3))
    # CV -> Three.js
    def flip(v): return [v[0], -v[1], -v[2]]
    r1 = flip(r1); r2 = flip(r2); t = flip(t)
    sc = (norm(r1)+norm(r2))/2
    r1 = scale(r1,1/sc); r2 = scale(r2,1/sc); t = scale(t,1/sc)
    if t[2] > 0:
        r1 = scale(r1,-1); r2 = scale(r2,-1); t = scale(t,-1)
    e1 = scale(r1, 1/norm(r1))
    e2 = sub(r2, scale(e1, dot(r2,e1))); e2 = scale(e2, 1/norm(e2))
    e3 = cross(e1,e2); e3 = scale(e3, 1/norm(e3))
    toCam = scale(t, -1)
    toCam = scale(toCam, 1/norm(toCam))
    if chirality == 'z':      # 当前代码: 强制 e3.z>0
        if e3[2] < 0: e3 = scale(e3,-1)
    elif chirality == 'dot':  # 修复: 法线朝向相机半球
        if dot(e3, toCam) < 0: e3 = scale(e3,-1)
    return {'t': t, 'e3': e3}

def project(p3, f, cx, cy):
    x,y,z = p3
    return (f*x/(-z) + cx, cy + f*y/z)

def test_table_qr():
    iw, ih = 1280, 720
    cx, cy = iw/2, ih/2
    f = (ih/2)/math.tan(math.radians(45)/2)
    s = 5.0; half = s/2
    # 二维码平放桌面: 平面法线 = 世界+Y, 局部X=世界+X, 局部Y=世界+Z(朝向相机)
    x3 = [1,0,0]; y3 = [0,0,1]; n3 = [0,1,0]
    for t3 in ([0,-8,-25], [10,-6,-30], [-8,-12,-22]):
        corners3 = [
            [t3[i] - half*x3[i] - half*y3[i] for i in range(3)],
            [t3[i] + half*x3[i] - half*y3[i] for i in range(3)],
            [t3[i] + half*x3[i] + half*y3[i] for i in range(3)],
            [t3[i] - half*x3[i] + half*y3[i] for i in range(3)],
        ]
        ic = [project(p, f, cx, cy) for p in corners3]
        r_z = decompose(ic, iw, ih, s, 45, 'z')
        r_dot = decompose(ic, iw, ih, s, 45, 'dot')
        print(f'--- 二维码平放桌面 中心={[round(a,1) for a in t3]} 真实法线=[0,1,0] ---')
        print(f'  角点投影={[ [round(u),round(v)] for u,v in ic ]}')
        if r_z:  print(f'  当前代码(z>0): t={[round(a,2) for a in r_z["t"]]} e3={[round(a,2) for a in r_z["e3"]]}')
        if r_dot: print(f'  修复(dot>0):  t={[round(a,2) for a in r_dot["t"]]} e3={[round(a,2) for a in r_dot["e3"]]}')
    print()
    # 竖立持卡场景: QR 竖直朝向相机(法线=+Z 略偏), 验证两种 chirality 一致
    print('--- 二维码竖直手持(法线朝向相机) ---')
    for t3, n3 in [([0,0,-30],[0,0,1]), ([5,3,-25],[0.2,0.3,0.93])]:
        up = [0,1,0]
        x3 = [up[1]*n3[2]-up[2]*n3[1], up[2]*n3[0]-up[0]*n3[2], up[0]*n3[1]-up[1]*n3[0]]
        xn = math.sqrt(sum(a*a for a in x3))
        if xn < 1e-6: x3 = [1,0,0]
        else: x3 = [a/xn for a in x3]
        y3 = [n3[1]*x3[2]-n3[2]*x3[1], n3[2]*x3[0]-n3[0]*x3[2], n3[0]*x3[1]-n3[1]*x3[0]]
        corners3 = [
            [t3[i] - half*x3[i] - half*y3[i] for i in range(3)],
            [t3[i] + half*x3[i] - half*y3[i] for i in range(3)],
            [t3[i] + half*x3[i] + half*y3[i] for i in range(3)],
            [t3[i] - half*x3[i] + half*y3[i] for i in range(3)],
        ]
        ic = [project(p, f, cx, cy) for p in corners3]
        r_z = decompose(ic, iw, ih, s, 45, 'z')
        r_dot = decompose(ic, iw, ih, s, 45, 'dot')
        print(f'  中心={[round(a,1) for a in t3]} 真实法线={[round(a,2) for a in n3]}')
        if r_z:  print(f'    当前(z>0): e3={[round(a,2) for a in r_z["e3"]]}')
        if r_dot: print(f'    修复(dot): e3={[round(a,2) for a in r_dot["e3"]]}')

test_table_qr()
