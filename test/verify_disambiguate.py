# -*- coding: utf-8 -*-
"""验证方向消歧(disambiguatePose): 当原生检测把角点顺序旋转90°时, 有正确参考能纠正回真实方向。"""
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

def est_pose(corners, iw, ih, s, fov):
    src = [[-s/2,-s/2],[s/2,-s/2],[s/2,s/2],[-s/2,s/2]]
    dst = [[p[0],p[1]] for p in corners]
    h = solve_homography_dlt(src, dst)
    if not h: return None
    cx, cy = iw/2, ih/2
    f = (ih/2)/math.tan(math.radians(fov)/2)
    g = [h[0]/f - cx*h[6]/f, h[1]/f - cx*h[7]/f, h[2]/f - cx*h[8]/f,
         h[3]/f - cy*h[6]/f, h[4]/f - cy*h[7]/f, h[5]/f - cy*h[8]/f,
         h[6], h[7], h[8]]
    r1=[g[0],g[3],g[6]]; r2=[g[1],g[4],g[7]]; t=[g[2],g[5],g[8]]
    def norm(v): return math.sqrt(sum(a*a for a in v))
    def scale(v,k): return [a*k for a in v]
    def sub(a,b): return [a[i]-b[i] for i in range(3)]
    def cross(a,b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    def dot(a,b): return sum(a[i]*b[i] for i in range(3))
    def flip(v): return [v[0], -v[1], -v[2]]
    r1=flip(r1); r2=flip(r2); t=flip(t)
    sc=(norm(r1)+norm(r2))/2
    r1=scale(r1,1/sc); r2=scale(r2,1/sc); t=scale(t,1/sc)
    if t[2] > 0: r1=scale(r1,-1); r2=scale(r2,-1); t=scale(t,-1)
    e1=scale(r1,1/norm(r1))
    e2=sub(r2, scale(e1,dot(r2,e1))); e2=scale(e2,1/norm(e2))
    e3=cross(e1,e2); e3=scale(e3,1/norm(e3))
    toCam=scale(t,-1); toCam=scale(toCam,1/norm(toCam))
    if dot(e3,toCam)<0: e3=scale(e3,-1)
    return {'t':t,'e3':e3,'e1':e1,'e2':e2}

def quat_from_basis(e1,e2,e3):
    # 用 e1,e2,e3 作为基列向量构造旋转矩阵, 转四元数
    m00,m01,m02=e1[0],e2[0],e3[0]
    m10,m11,m12=e1[1],e2[1],e3[1]
    m20,m21,m22=e1[2],e2[2],e3[2]
    tr=m00+m11+m22
    if tr>0:
        S=math.sqrt(tr+1.0)*2
        return [(m21-m12)/S,(m02-m20)/S,(m10-m01)/S,0.25*S]
    if m00>m11 and m00>m22:
        S=math.sqrt(1.0+m00-m11-m22)*2
        return [0.25*S,(m01+m10)/S,(m02+m20)/S,(m21-m12)/S]
    if m11>m22:
        S=math.sqrt(1.0+m11-m00-m22)*2
        return [(m01+m10)/S,0.25*S,(m12+m21)/S,(m02-m20)/S]
    S=math.sqrt(1.0+m22-m00-m11)*2
    return [(m02+m20)/S,(m12+m21)/S,0.25*S,(m10-m01)/S]

def project(p3, f, cx, cy):
    x,y,z=p3
    return (f*x/(-z)+cx, cy+f*y/z)

def test():
    iw,ih=1280,720; cx,cy=iw/2,ih/2
    f=(ih/2)/math.tan(math.radians(45)/2)
    s=5.0; half=s/2
    # 二维码竖直放置, 法线朝相机(带一点偏移), 中心 (0,0,-30)
    n3=[0,0.2,0.98]
    # 平面内基: 局部+X 大致=世界+X, 局部+Y = n3 x X
    x3=[1,0,0]
    def norm(v): return math.sqrt(sum(a*a for a in v))
    y3=[n3[1]*x3[2]-n3[2]*x3[1], n3[2]*x3[0]-n3[0]*x3[2], n3[0]*x3[1]-n3[1]*x3[0]]
    y3=[a/norm(y3) for a in y3]
    t3=[0,0,-30]
    TL=[t3[i]-half*x3[i]-half*y3[i] for i in range(3)]
    TR=[t3[i]+half*x3[i]-half*y3[i] for i in range(3)]
    BR=[t3[i]+half*x3[i]+half*y3[i] for i in range(3)]
    BL=[t3[i]-half*x3[i]+half*y3[i] for i in range(3)]
    img=[project(p,f,cx,cy) for p in [TL,TR,BR,BL]]
    print('jsQR 顺序角点投影:', [[round(u),round(v)] for u,v in img])
    p_jsqr = est_pose(img, iw, ih, s, 45)
    q_jsqr = quat_from_basis(p_jsqr['e1'],p_jsqr['e2'],p_jsqr['e3'])
    print(f'jsQR 正确方向: t={[round(a,2) for a in p_jsqr["t"]]} q=({",".join(f"{a:.2f}" for a in q_jsqr)})')
    # 模拟原生: 角点顺序旋转 90° (从 TR 开始)
    rotated=[img[1],img[2],img[3],img[0]]
    # 无参考: 默认顺序
    p_native_default = est_pose(rotated, iw, ih, s, 45)
    q_nd = quat_from_basis(p_native_default['e1'],p_native_default['e2'],p_native_default['e3'])
    print(f'原生无参考(错): t={[round(a,2) for a in p_native_default["t"]]} q=({",".join(f"{a:.2f}" for a in q_nd)})')
    # 有 jsQR 参考: 消歧选最接近的排列
    PERMS=[[0,1,2,3],[1,2,3,0],[2,3,0,1],[3,0,1,2]]
    best=None; bestScore=-1e9
    for k,p in enumerate(PERMS):
        c=[rotated[p[i]] for i in range(4)]
        po=est_pose(c,iw,ih,s,45)
        if not po: continue
        q=quat_from_basis(po['e1'],po['e2'],po['e3'])
        score=abs(q[0]*q_jsqr[0]+q[1]*q_jsqr[1]+q[2]*q_jsqr[2]+q[3]*q_jsqr[3])
        print(f'  排列{k} {p}: score={score:.3f} t=({",".join(f"{a:.2f}" for a in po["t"])})')
        if score>bestScore: bestScore=score; best=po
    print(f'消歧后 t={[round(a,2) for a in best["t"]]}  与真实 (0,0,-30) 对比')

test()
