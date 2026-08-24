# -*- coding: utf-8 -*-
"""验证: DLT 位姿 + 高斯-牛顿重投影优化, 在大角度+噪声下是否显著改善精度。"""
import math, random

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

def est_pose_dlt(corners, iw, ih, s, fov):
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
    def flip(v): return [v[0],-v[1],-v[2]]
    r1=flip(r1); r2=flip(r2); t=flip(t)
    sc=(norm(r1)+norm(r2))/2
    r1=scale(r1,1/sc); r2=scale(r2,1/sc); t=scale(t,1/sc)
    if t[2] > 0: r1=scale(r1,-1); r2=scale(r2,-1); t=scale(t,-1)
    return {'r1':r1,'r2':r2,'t':t}

def rodrigues(w):
    th = math.sqrt(w[0]*w[0]+w[1]*w[1]+w[2]*w[2])
    K = [[0,-w[2],w[1]],[w[2],0,-w[0]],[-w[1],w[0],0]]
    if th < 1e-12: return [[1,0,0],[0,1,0],[0,0,1]]
    K2 = [[sum(K[i][k]*K[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    I = [[1,0,0],[0,1,0],[0,0,1]]
    a = math.sin(th)/th; b = (1-math.cos(th))/(th*th)
    return [[I[i][j]+a*K[i][j]+b*K2[i][j] for j in range(3)] for i in range(3)]

def R2axis(R):
    ang = math.acos(max(-1,min(1,(R[0][0]+R[1][1]+R[2][2]-1)/2)))
    if ang < 1e-8: return [0,0,0]
    s = 2*math.sin(ang)
    return [(R[2][1]-R[1][2])/s, (R[0][2]-R[2][0])/s, (R[1][0]-R[0][1])/s]

def applyR(R, v):
    return [sum(R[i][j]*v[j] for j in range(3)) for i in range(3)]

def mv(M, v):
    return [sum(M[i][j]*v[j] for j in range(len(v))) for i in range(len(M))]

def matmul(A,B):
    return [[sum(A[i][k]*B[k][j] for k in range(len(B))) for j in range(len(B[0]))] for i in range(len(A))]

def gn_refine(R0, t0, obj, img, f, cx, cy, iters=15):
    p = [0.0]*6
    w = R2axis(R0)
    p[0],p[1],p[2]=w
    p[3],p[4],p[5]=t0
    def resid(pp):
        Rm = rodrigues(pp[0:3])
        out=[]
        for i in range(len(obj)):
            cp = mv(Rm, [obj[i][0],obj[i][1],0.0])
            x=cp[0]+pp[3]; y=cp[1]+pp[4]; z=cp[2]+pp[5]
            if z > -1e-6: out += [1e4,1e4]; continue
            out += [f*x/(-z)+cx-img[i][0], cy+f*y/z-img[i][1]]
        return out
    for _ in range(iters):
        r = resid(p)
        J=[]
        eps=1e-5
        for k in range(6):
            p2=list(p); p2[k]+=eps
            r2=resid(p2)
            J.append([(r2[i]-r[i])/eps for i in range(len(r))])
        JTJ=[[0.0]*6 for _ in range(6)]; JTr=[0.0]*6
        for i in range(6):
            for j in range(6):
                JTJ[i][j]=sum(J[i][m]*J[j][m] for m in range(len(r)))
            JTr[i]=sum(J[i][m]*r[m] for m in range(len(r)))
        lam=0.01
        for i in range(6): JTJ[i][i]+=lam
        # 解 (JTJ)Δ = -JTr
        A=[row+[-JTr[i]] for i,row in enumerate(JTJ)]
        for col in range(6):
            pivot=max(range(col,6), key=lambda rr: abs(A[rr][col]))
            if abs(A[pivot][col])<1e-12: return None
            A[col],A[pivot]=A[pivot],A[col]
            for rr in range(6):
                if rr==col: continue
                fct=A[rr][col]/A[col][col]
                for cc in range(col,7): A[rr][cc]-=fct*A[col][cc]
        delta=[A[i][6]/A[i][i] for i in range(6)]
        if max(abs(d) for d in delta)<1e-8: break
        for i in range(6): p[i]+=delta[i]
    return {'R':rodrigues(p[0:3]),'t':p[3:6]}

def project(p3, f, cx, cy):
    x,y,z=p3
    return (f*x/(-z)+cx, cy+f*y/z)

def test():
    random.seed(1)
    iw,ih=1280,720; cx,cy=iw/2,ih/2
    f=(ih/2)/math.tan(math.radians(45)/2)
    s=5.0; half=s/2
    # 大角度场景: 二维码绕X轴倾斜 60度, 法线偏上
    a=math.radians(60)
    # 旋转轴: 世界X, 使二维码从竖直(法线朝+Z)向后仰60度 -> 法线指向(0,sin60,cos60)
    n3=[0, math.sin(a), math.cos(a)]
    # 平面内基: e1=世界X(1,0,0); e2=世界Y(0,1,0) 不垂直了, 需要正交化
    e1=[1,0,0]
    def norm(v): return math.sqrt(sum(q*q for q in v))
    e2=[n3[1]*e1[2]-n3[2]*e1[1], n3[2]*e1[0]-n3[0]*e1[2], n3[0]*e1[1]-n3[1]*e1[0]]
    e2=[q/norm(e2) for q in e2]
    t3=[0,0,-30]
    TL=[t3[i]-half*e1[i]-half*e2[i] for i in range(3)]
    TR=[t3[i]+half*e1[i]-half*e2[i] for i in range(3)]
    BR=[t3[i]+half*e1[i]+half*e2[i] for i in range(3)]
    BL=[t3[i]-half*e1[i]+half*e2[i] for i in range(3)]
    pts3=[TL,TR,BR,BL]
    true_t=t3; true_n=n3
    for noise in (0.0, 1.0, 2.0):
        img=[]
        for p in pts3:
            u,v=project(p,f,cx,cy)
            u+=random.uniform(-noise,noise); v+=random.uniform(-noise,noise)
            img.append([u,v])
        dlt=est_pose_dlt(img,iw,ih,s,45)
        R0=rodrigues([0,0,0])
        # 从 dlt 构建初始 R: 列 = r1,r2,r3(=r1×r2)
        r1,r2=dlt['r1'],dlt['r2']
        r3=[r1[1]*r2[2]-r1[2]*r2[1], r1[2]*r2[0]-r1[0]*r2[2], r1[0]*r2[1]-r1[1]*r2[0]]
        R0=[[r1[0],r2[0],r3[0]],[r1[1],r2[1],r3[1]],[r1[2],r2[2],r3[2]]]
        obj=[[-half,-half],[half,-half],[half,half],[-half,half]]
        gn=gn_refine(R0,dlt['t'],obj,img,f,cx,cy)
        def err_t(tt): return math.sqrt(sum((tt[i]-true_t[i])**2 for i in range(3)))
        def err_n(R):
            col3=[R[i][2] for i in range(3)]
            return math.acos(max(-1,min(1,sum(col3[i]*true_n[i] for i in range(3)))))
        dlt_n=err_n(R0); dlt_t=err_t(dlt['t'])
        gn_n=err_n(gn['R']); gn_t=err_t(gn['t'])
        print(f'噪声±{noise}px   DLT: 位置误差={dlt_t:.2f}cm 法线角={math.degrees(dlt_n):.1f}° | GN: 位置误差={gn_t:.2f}cm 法线角={math.degrees(gn_n):.1f}°')

test()
