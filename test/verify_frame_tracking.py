# -*- coding: utf-8 -*-
"""帧间仿真: 比较 每帧GN(DLT初值) vs 帧间GN(上帧位姿作初值) 的帧间抖动与镜像跳变。"""
import math, random
exec(open('verify_pnp_refine.py', encoding='utf-8').read().split('def test():')[0])  # 复用 rodrigues/gn_refine/R2axis 等

def dlt_pose(corners, iw, ih, s, fov):
    p = est_pose_dlt(corners, iw, ih, s, fov)
    if not p: return None
    r1,r2 = p['r1'], p['r2']
    r3=[r1[1]*r2[2]-r1[2]*r2[1], r1[2]*r2[0]-r1[0]*r2[2], r1[0]*r2[1]-r1[1]*r2[0]]
    R=[[r1[0],r2[0],r3[0]],[r1[1],r2[1],r3[1]],[r1[2],r2[2],r3[2]]]
    return {'R':R,'t':p['t']}

def rot_x(a):
    c,s=math.cos(a),math.sin(a)
    return [[1,0,0],[0,c,-s],[0,s,c]]

def rot_y(a):
    c,s=math.cos(a),math.sin(a)
    return [[c,0,s],[0,1,0],[-s,0,c]]

def mv(M,v): return [sum(M[i][j]*v[j] for j in range(3)) for i in range(3)]

def main():
    random.seed(7)
    iw,ih=1280,720; cx,cy=iw/2,ih/2
    f=(ih/2)/math.tan(math.radians(45)/2)
    s=5.0; half=s/2
    # 二维码本地角点
    pts_local=[[-half,-half,0],[half,-half,0],[half,half,0],[-half,half,0]]
    def project(p):
        x,y,z=p
        return [f*x/(-z)+cx, cy+f*y/z]
    # 模拟二维码缓慢运动: 世界位置绕圈 + 缓慢旋转, 连续 60 帧
    # 二维码姿态 R(t), t(t)
    def pose_at(i):
        # 中心绕圈: 半径 6cm, 在 XZ 平面
        ang = i*0.02
        t = [6*math.sin(ang), 0, -30 + 6*math.cos(ang)]
        # 姿态: 绕Y转 ang/2, 绕X -30度固定
        R = matmul(rot_x(-math.radians(30)), rot_y(ang*0.5))
        return R, t
    frames=[]
    for i in range(60):
        R,t = pose_at(i)
        img=[]
        for lp in pts_local:
            wp = mv(R, lp)
            cam=[wp[0]+t[0], wp[1]+t[1], wp[2]+t[2]]
            u,v=project(cam)
            u+=random.uniform(-1,1); v+=random.uniform(-1,1)
            img.append([u,v])
        frames.append((R,t,img))
    # 方法1: 每帧 DLT + GN(自带初值)
    print('=== 每帧 DLT 初值 ===')
    prev=None
    for i,(R,t,img) in enumerate(frames):
        d=dlt_pose(img,iw,ih,s,45)
        gn=gn_refine(d['R'],d['t'],[[-half,-half],[half,-half],[half,half],[-half,half]],img,f,cx,cy)
        # 与真实对比
        def terr(tt): return math.sqrt(sum((tt[j]-t[j])**2 for j in range(3)))
        col3=[gn['R'][k][2] for k in range(3)]
        # 与上帧位置跳变
        if prev:
            jump=math.sqrt(sum((gn['t'][j]-prev[j])**2 for j in range(3)))
            if jump>1.5: print(f'  帧{i}: 位置跳变 {jump:.2f}cm')
        prev=gn['t']
        if i in (0,10,30,59):
            print(f'  帧{i}: t_err={terr(gn["t"]):.2f}cm 法线=({",".join(f"{v:.2f}" for v in col3)})')
    print('=== 帧间 GN(上帧位姿作初值) ===')
    prevR=None; prevt=None
    jumps=0
    for i,(R,t,img) in enumerate(frames):
        d=dlt_pose(img,iw,ih,s,45)
        R0=d['R'] if prevR is None else prevR
        t0=d['t'] if prevt is None else prevt
        gn=gn_refine(R0,t0,[[-half,-half],[half,-half],[half,half],[-half,half]],img,f,cx,cy)
        def terr(tt): return math.sqrt(sum((tt[j]-t[j])**2 for j in range(3)))
        col3=[gn['R'][k][2] for k in range(3)]
        if prevt is not None:
            jump=math.sqrt(sum((gn['t'][j]-prevt[j])**2 for j in range(3)))
            if jump>1.5:
                jumps+=1
                print(f'  帧{i}: 位置跳变 {jump:.2f}cm')
        prevR=gn['R']; prevt=gn['t']
        if i in (0,10,30,59):
            print(f'  帧{i}: t_err={terr(gn["t"]):.2f}cm 法线=({",".join(f"{v:.2f}" for v in col3)})')
    print(f'帧间GN 大跳变次数: {jumps}')

main()
