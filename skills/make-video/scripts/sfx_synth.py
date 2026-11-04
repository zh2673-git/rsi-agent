"""程序化音效合成：让"冲击"能被笔记本/手机扬声器真实还原。

问题根源：旧 hit.wav 是 sine=f=58 一条纯正弦，100% 能量在 20–120Hz。
小尺寸扬声器放不出这段低频，只会露出功放失真与谐波拍频 —— 听感就是"刺啦"。

做法：换成"三层拼一个瞬态"的拟音思路
  body  58Hz 指数下滑正弦（给大箱体手感，但只占小部分能量）
  click 1.2–3.5kHz 极短包络（这才是耳朵判定"硬"的部位）
  noise 带通白噪 8ms（空气/接触感）
三者错开 6–18ms 起音（J-cut 先 low 后 click），总时长仍 <0.5s。

whoosh 加宽到 200Hz–5kHz 并做真实扫频（带通中心从 380Hz 扫到 3.2kHz），
旧版固定 lowpass=1400 会把噪声压成"沙沙"。

用法:
  python sfx_synth.py --dir <audio/mix/sfx 目录>
"""
import argparse
import os
import wave

import numpy as np

SR = 48000


def write(path, x):
    x = np.clip(x, -1, 1)
    pcm = (x * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def band(x, lo, hi):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))


def hit(dur=0.55, seed=0):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)

    # body：58→44Hz 下滑，短（权重压到 0.34：小扬声器放不出这段，只给大箱体手感）
    f = 44 + 26 * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    y += np.sin(ph) * np.exp(-t / 0.050) * 0.30

    # click：1.2–3.5k，起音 8ms 后进入（先手感后脆感）——这才是耳朵判定"硬"的部位
    cn = int(0.11 * SR)
    ct = np.arange(cn) / SR
    click = np.zeros(cn)
    for freq, a, tau in [(1180, 0.55, 0.010), (1760, 0.40, 0.008), (2480, 0.30, 0.006), (3350, 0.20, 0.005)]:
        click += a * np.sin(2 * np.pi * freq * ct + freq * 0.01) * np.exp(-ct / tau)
    click *= np.clip(ct / 0.0015, 0, 1)
    off = int(0.006 * SR)
    y[off:off + cn] += click[: max(0, min(cn, n - off))] * 1.05

    # noise：8ms 带通瞬态（空气/接触感）
    nn = int(0.05 * SR)
    noise = band(rng.normal(0, 1, nn), 700, 5500) * np.exp(-np.arange(nn) / (0.010 * SR))
    off2 = int(0.014 * SR)
    seg = noise[: max(0, min(nn, n - off2))]
    y[off2:off2 + len(seg)] += seg * 0.55

    y *= np.clip(t / 0.0012, 0, 1)
    y = band(y, 40, 14000)
    return y / (np.abs(y).max() + 1e-9) * 0.72


def whoosh(dur=0.75, seed=1):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    src = rng.normal(0, 1, n)
    # 时变带通：中心频率随时间扫（分段滤波再拼接，避免逐样本 filter 开销）
    segs = 24
    out = np.zeros(n)
    for i in range(segs):
        a, b = int(i * n / segs), int((i + 1) * n / segs)
        u = i / (segs - 1)
        center = 380 + (3200 - 380) * (u ** 0.75)
        width = center * 0.85
        chunk = src[a:b]
        pad = np.concatenate([src[max(0, a - 2048):a], chunk, src[b:b + 2048]])
        filt = band(pad, max(120, center - width), min(12000, center + width))
        out[a:b] = filt[2048:2048 + (b - a)]
    # 包络：快起慢落（空气被推开的形状）
    e = np.clip(t / 0.22, 0, 1) ** 1.4 * np.clip((dur - t) / 0.34, 0, 1) ** 1.1
    out *= e
    out = band(out, 180, 9000)
    return out / (np.abs(out).max() + 1e-9) * 0.55


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    a = ap.parse_args()
    os.makedirs(a.dir, exist_ok=True)
    write(os.path.join(a.dir, "hit.wav"), hit())
    write(os.path.join(a.dir, "whoosh.wav"), whoosh())
    print("wrote", a.dir)


if __name__ == "__main__":
    main()
