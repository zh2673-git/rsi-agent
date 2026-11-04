"""程序化配乐合成（无音源依赖）：暖调极简科技 bed。

为什么不用正弦堆 pad：10 路纯正弦 + 低通 = 20–120Hz 占 71% 能量的 drone，
笔记本扬声器放不出来只会露谐波与拍频（听感"刺啦"），且 120–400Hz 正好压住人声。

这里改成"有编排的音乐"：
  骨架  Am7 → Fmaj7 → Cmaj7 → G6（84BPM，每和弦 2 小节，8 小节一循环）
  织体  拨弦琶音（立体声 ping-pong）+ 暖 pad + 根音贝斯 + 极轻 kick/shaker
  弧线  循环渐进：稀疏 → 加贝斯/沙锤 → 加 kick 与高八度 → 抬升 → 收尾渐弱
  音色  拨弦用整数泛音列快速衰减（有基频、不发虚）；pad 只走 150–1500Hz；
        全部信号末端 45Hz 高通，杜绝次声与拍频
输出 44.1k / 16bit / 立体声，RMS 约 -24dBFS，供混音阶段再做 EQ 让位与 ducking。

用法: python bgm_synth.py --ms 121920 --out bgm-music.wav [--seed 3]
"""
import argparse
import wave

import numpy as np

SR = 44100
BPM = 84.0
BEAT = 60.0 / BPM


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


# 和弦：根音(贝斯) / pad 声部 / 拨弦可选取音
PROG = [
    {"bass": 45, "pad": [57, 60, 64, 67], "arp": [69, 72, 76, 79, 81]},      # Am7
    {"bass": 41, "pad": [53, 57, 60, 64], "arp": [65, 69, 72, 76, 77]},      # Fmaj7
    {"bass": 48, "pad": [55, 59, 60, 64], "arp": [72, 76, 79, 83, 84]},      # Cmaj7
    {"bass": 43, "pad": [55, 59, 62, 64], "arp": [67, 71, 74, 76, 79]},      # G6
]


def env_exp(n, tau, attack=0.004):
    t = np.arange(n) / SR
    e = np.exp(-t / tau)
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return e * a


def pluck(freq, dur, amp, bright=1.0):
    """整数泛音列 + 快速衰减：有明确基频，中高频是音乐性的不是噪声。

    高次泛音衰减比低次更快（真实弦的物理行为），所以听感是"亮而短"，
    不是"一直嗡"——这正是把能量推到 1–4k 又不显吵的做法。
    """
    n = int(dur * SR)
    t = np.arange(n) / SR
    parts = [
        (1, 1.00, 0.50), (2, 0.52, 0.30), (3, 0.34, 0.22), (4, 0.24, 0.16),
        (5, 0.17, 0.12), (6, 0.12, 0.095), (7, 0.09, 0.075), (8, 0.06, 0.06),
        (10, 0.04, 0.045), (12, 0.025, 0.035),
    ]
    y = np.zeros(n)
    for k, a, tau in parts:
        if freq * k > 13000:
            continue
        y += a * bright * np.sin(2 * np.pi * freq * k * t + k * 0.7) * np.exp(-t / (tau * 0.9))
    y *= np.clip(t / 0.003, 0, 1)
    # 起音瞬态（短促、带限），让拨弦有"指尖"
    tn = int(0.006 * SR)
    y[:tn] += np.random.default_rng(int(freq) % 997).normal(0, 0.05, tn) * np.linspace(1, 0, tn)
    return y * amp


def bell(freq, dur, amp, seed=0):
    """钟琴/罗兹音色：非整数泛音（金属感但协和），能量集中在 1.5–5k，补空气感。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for ratio, a, tau in [(1.0, 1.0, 0.55), (2.01, 0.42, 0.34), (3.02, 0.22, 0.22), (4.98, 0.13, 0.15), (6.9, 0.07, 0.10)]:
        f = freq * ratio
        if f > 11000:
            continue
        y += a * np.sin(2 * np.pi * f * t + seed * 0.6) * np.exp(-t / tau)
    y *= np.clip(t / 0.004, 0, 1)
    return y * amp


def pad(freqs, dur, amp, phase0=0.0):
    """暖 pad：三重微失谐正弦 + 慢 LFO，只保留低次泛音，不做低通。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for i, f in enumerate(freqs):
        for det in (-4.0, 0.0, 4.0):
            fd = f * 2 ** (det / 1200.0)
            lfo = 1.0 + 0.12 * np.sin(2 * np.pi * (0.07 + 0.017 * i) * t + i + phase0)
            y += np.sin(2 * np.pi * fd * t + i * 1.3) * lfo
            y += 0.18 * np.sin(2 * np.pi * fd * 2 * t + i)
    y /= max(1, len(freqs) * 3)
    a = np.clip(t / 1.6, 0, 1)
    r = np.clip((dur - t) / 2.2, 0, 1)
    return y * a * r * amp


def bass(freq, dur, amp):
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.sin(2 * np.pi * freq * t) + 0.20 * np.sin(4 * np.pi * freq * t) + 0.06 * np.sin(6 * np.pi * freq * t)
    a = np.clip(t / 0.02, 0, 1) * np.clip((dur - t) / 0.25, 0, 1)
    return y * a * amp


def kick(amp):
    n = int(0.24 * SR)
    t = np.arange(n) / SR
    f = 48 + 64 * np.exp(-t / 0.045)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.11) * amp


def shaker(amp, rng):
    n = int(0.06 * SR)
    x = rng.normal(0, 1, n)
    # 一阶差分做高通，再两点平均柔化：得到 5–11k 的"沙"
    x = np.diff(x, prepend=0.0)
    x = np.convolve(x, [0.5, 0.5], mode="same")
    return x * np.exp(-np.arange(n) / (0.014 * SR)) * amp


def band_mask(x, lo, hi):
    """频域硬掩码（整段一次 FFT，成本低且无相位拖尾）。"""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))


def reverb_ir(seed, t60=1.35):
    n = int(t60 * SR)
    rng = np.random.default_rng(seed)
    ir = rng.normal(0, 1, n) * np.exp(-np.arange(n) / (t60 * SR / 6.2))
    ir = band_mask(ir, 180, 7000)
    ir[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
    return ir / (np.abs(ir).sum() / 12.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ms", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    total = a.ms / 1000.0
    n = int((total + 2.0) * SR)  # 尾部留混响衰减
    rng = np.random.default_rng(a.seed)

    L = np.zeros(n)
    R = np.zeros(n)
    wetL_src = np.zeros(n)
    wetR_src = np.zeros(n)

    def add(buf, sig, at, gain=1.0, pan=0.5, wet=0.0):
        i = int(at * SR)
        if i >= n:
            return
        seg = sig[: n - i]
        gl = gain * np.cos(pan * np.pi / 2)
        gr = gain * np.sin(pan * np.pi / 2)
        buf[0][i: i + len(seg)] += seg * gl
        buf[1][i: i + len(seg)] += seg * gr
        if wet > 0:
            wetL_src[i: i + len(seg)] += seg * gl * wet
            wetR_src[i: i + len(seg)] += seg * gr * wet

    buf = (L, R)

    bar = 4 * BEAT                 # 一小节 ≈ 2.857s
    cycle = 8 * bar                # 8 小节一循环 ≈ 22.9s
    ncycles = int(np.ceil(total / cycle)) + 1

    for c in range(ncycles):
        base = c * cycle
        if base > total:
            break
        # 弧线：前 1 循环稀疏，中段丰满，末段回落
        prog_pos = (base + cycle / 2) / total
        fullness = 0.0 if prog_pos < 0.06 else (1.0 if prog_pos < 0.30 else (1.0 if prog_pos < 0.78 else 0.55))
        lift = 2 if 0.46 <= prog_pos < 0.78 else 0  # 中后段整体升全音，给情绪台阶
        for ci, ch in enumerate(PROG):
            t0 = base + ci * 2 * bar
            if t0 > total:
                break
            shift = lift
            pad_f = [mtof(m + shift) for m in ch["pad"]]
            # pad 铺满两小节
            add(buf, pad(pad_f, 2 * bar + 1.2, 0.16), t0, pan=0.5, wet=0.55)
            # 贝斯：每小节一下，第 3 拍再补一下
            add(buf, bass(mtof(ch["bass"] + shift), 1.6 * bar / 2 + 0.5, 0.34), t0, wet=0.05)
            if fullness > 0.5:
                add(buf, bass(mtof(ch["bass"] + shift + 12), 0.9, 0.16), t0 + 2 * bar - 1.0, wet=0.05)
            # 拨弦琶音：八分音符网格，留白 25%，立体声左右摆
            arp = [m + shift for m in ch["arp"]]
            for step in range(16):  # 2 小节 = 16 个八分
                if rng.random() < (0.30 if fullness < 0.5 else 0.18):
                    continue
                at = t0 + step * BEAT / 2
                if at > total:
                    continue
                idx = [0, 2, 1, 3, 2, 4, 1, 3][step % 8]
                note = arp[idx % len(arp)]
                vel = 0.20 + 0.08 * rng.random() + (0.05 if step % 4 == 0 else 0.0)
                pan = 0.34 if step % 2 == 0 else 0.66
                add(buf, pluck(mtof(note), 1.1, vel, bright=1.05), at, pan=pan, wet=0.65)
                # 钟琴点缀：每两拍的强拍加一个高八度音，补 2–6k 空气感（很轻，不抢人声）
                if step % 8 == 0 or step % 8 == 6:
                    if fullness > 0.4:
                        add(buf, bell(mtof(note + 12), 1.6, 0.085, seed=step), at, pan=0.5, wet=0.75)
            # 节奏层
            if fullness > 0.5:
                for step in range(8):
                    if step in (0, 4):
                        add(buf, kick(0.30), t0 + step * BEAT / 2, wet=0.02)
                    add(buf, shaker(0.030, rng), t0 + step * BEAT / 2 + BEAT / 4, pan=0.6, wet=0.10)

    # 混响（左右独立 IR，得到宽而不糊的空间）
    mixL, mixR = L, R
    irL = reverb_ir(a.seed + 1)
    irR = reverb_ir(a.seed + 2)
    wl = np.fft.irfft(np.fft.rfft(wetL_src, n + len(irL) - 1) * np.fft.rfft(irL, n + len(irL) - 1), n + len(irL) - 1)[:n]
    wr = np.fft.irfft(np.fft.rfft(wetR_src, n + len(irL) - 1) * np.fft.rfft(irR, n + len(irL) - 1), n + len(irL) - 1)[:n]
    outL = band_mask(mixL + 0.26 * wl, 45, 12000)
    outR = band_mask(mixR + 0.26 * wr, 45, 12000)

    # 首尾淡入淡出 + 目标 RMS
    fade_in = int(1.8 * SR)
    fade_out = int(3.4 * SR)
    ramp = np.ones(n)
    ramp[:fade_in] = np.linspace(0, 1, fade_in)
    ramp[-fade_out:] = np.linspace(1, 0, fade_out)
    outL *= ramp
    outR *= ramp
    outL = outL[: int(total * SR)]
    outR = outR[: int(total * SR)]
    rms = np.sqrt((np.concatenate([outL, outR]) ** 2).mean()) + 1e-12
    g = 10 ** (-24 / 20) / rms
    st = np.stack([outL * g, outR * g], axis=1)
    st = np.tanh(st * 1.6) / 1.6
    pcm = np.clip(st * 32767, -32768, 32767).astype("<i2")
    with wave.open(a.out, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print("wrote", a.out, "dur", round(len(outL) / SR, 2), "s")


if __name__ == "__main__":
    main()
