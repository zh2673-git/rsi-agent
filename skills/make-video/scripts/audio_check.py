"""混音体检（V-SND-006 可听性闸门）：把"BGM 别盖人声 / 别只堆在小扬声器放不出的低频"量化。

指标与判据（阈值来自实测：旁白 vo-mix 的 speech 段中位 RMS 约 -25dBFS）：
  1. speech_delta = BGM(说话段) - VO(说话段)，要求 ≤ -12dB（人声明显在前）
  2. duck_depth   = BGM(停顿时) - BGM(说话时)，要求 ≥ 3dB（确实在让人声）
  3. low_share    = BGM 20–120Hz 能量占比，要求 ≤ 45%（小扬声器还原不出来就会变"刺啦"）
  4. mid_share    = BGM 400–6000Hz 能量占比，要求 ≥ 8%（中高频有内容才听得见"音乐"而不是"轰隆"）
  5. sfx_low      = hit/音效 20–120Hz 占比，要求 ≤ 60%

用法: python scripts/audio_check.py --files <mix dir 的 bgm.wav vo-mix.wav 与 sfx/hit.wav>
"""
import argparse
import json
import subprocess
import sys

import numpy as np

SR = 22050
HOP = int(0.05 * SR)


def load(path, ac=1, sr=SR):
    p = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", path, "-ac", str(ac), "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True,
    )
    x = np.frombuffer(p.stdout, dtype=np.float32)
    if len(x) == 0:
        return None
    return x.reshape(-1, ac) if ac > 1 else x


def env(x):
    n = len(x) // HOP
    return np.array([np.sqrt((x[i * HOP:(i + 1) * HOP] ** 2).mean() + 1e-20) for i in range(n)])


def db(v):
    return 20 * np.log10(v + 1e-12)


def bands(path, sr=22050):
    x = load(path, 1, sr)
    if x is None:
        return None
    n = min(len(x), sr * 30)
    P = np.abs(np.fft.rfft(x[:n] * np.hanning(n))) ** 2
    f = np.fft.rfftfreq(n, 1 / sr)
    tot = P.sum() + 1e-12
    share = {}
    for lo, hi in [(20, 120), (120, 400), (400, 1200), (1200, 6000), (6000, 12000)]:
        k = (f >= lo) & (f < hi)
        share[f"{lo}-{hi}"] = round(100 * P[k].sum() / tot, 1)
    return share


def bands_transient(path, sr=48000, win=0.05):
    """只统计起音窗口（默认前 50ms）的频段占比。

    音效的听感判定发生在起音瞬态：body 的低频尾巴虽然能量大，但已过耳朵的
    "硬/软"判定点，把它算进来会把实测指标带偏（不是音色差，是统计口径错）。
    """
    x = load(path, 1, sr)
    if x is None:
        return None
    n = int(win * sr)
    seg = x[:n]
    P = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
    f = np.fft.rfftfreq(len(seg), 1 / sr)
    tot = P.sum() + 1e-12
    share = {}
    for lo, hi in [(20, 120), (120, 400), (400, 1200), (1200, 6000), (6000, 12000)]:
        k = (f >= lo) & (f < hi)
        share[f"{lo}-{hi}"] = round(100 * P[k].sum() / tot, 1)
    return share


def check(mixdir):
    vo_path = mixdir + "/vo-mix.wav"
    bed_path = mixdir + "/bgm.wav"
    vo = load(vo_path, 1)
    bed = load(bed_path, 2)
    if vo is None or bed is None:
        return {"ok": False, "error": "缺 vo-mix.wav / bgm.wav"}
    bl = bed.max(axis=1) if bed.ndim > 1 else bed
    n = min(len(vo), len(bl))
    v, b = db(env(vo[:n])), db(env(bl[:n]))
    speech = v > -38                      # 有人声
    gap = v < -55                         # 停顿
    res = {"speechFrac": round(float(speech.mean()), 3)}
    res["voSpeechDb"] = round(float(np.median(v[speech])), 1)
    res["bedSpeechDb"] = round(float(np.median(b[speech])), 1)
    res["speechDelta"] = round(res["bedSpeechDb"] - res["voSpeechDb"], 1)
    if gap.any():
        res["bedGapDb"] = round(float(np.median(b[gap])), 1)
        res["duckDepth"] = round(res["bedGapDb"] - res["bedSpeechDb"], 1)
    else:
        res["bedGapDb"] = None
        res["duckDepth"] = None
    bb = bands(bed_path)
    if bb:
        res["bgmLowShare"] = bb["20-120"]
        res["bgmMidShare"] = round(bb["400-1200"] + bb["1200-6000"], 1)
    sh = bands_transient(mixdir + "/sfx/hit.wav", 48000, 0.05)
    if sh:
        res["sfxLowShare"] = sh["20-120"]

    issues = []
    if res["speechDelta"] > -12:
        issues.append(f"V-SND-006 BGM 在人声段只低于旁白 {-res['speechDelta']:.1f}dB（需 ≤ -12dB）")
    if res["duckDepth"] is not None and res["duckDepth"] < 3:
        issues.append(f"V-SND-006 ducking 深度 {res['duckDepth']}dB 不足（需 ≥3dB）")
    if res.get("bgmLowShare", 0) > 45:
        issues.append(
            f"V-SND-006 BGM 低频占比 {res['bgmLowShare']}%（>45% 小扬声器放不出，会成'刺啦'）"
        )
    if res.get("bgmMidShare", 99) < 8:
        issues.append(f"V-SND-006 BGM 中高频占比 {res['bgmMidShare']}%（<8% 听不出旋律）")
    if res.get("sfxLowShare", 0) > 60:
        issues.append(f"V-SND-006 冲击音效低频占比 {res['sfxLowShare']}%（>60% 小扬声器无法还原）")
    res["issues"] = issues
    res["ok"] = not issues
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mixdir", nargs="+", required=True)
    a = ap.parse_args()
    out = {}
    bad = 0
    for d in a.mixdir:
        r = check(d)
        out[d] = r
        if not r["ok"]:
            bad += 1
    print(json.dumps(out, ensure_ascii=False, indent=1))
    sys.exit(1 if bad else 0)
