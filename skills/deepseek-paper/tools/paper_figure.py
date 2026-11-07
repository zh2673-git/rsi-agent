#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""paper_figure — 按 DeepSeek 视觉规范出图（三线网格、统一色系、自己突出、无多余边框）。

协议：stdin 收 {"args": {...}}，stdout 回 {"ok": true, "result": {...}}。
args:
  data   必填，图数据文件（templates/05-图表数据.json 的 kind=figure 段）或 JSON 本身
  out    必填，输出图片路径（.png/.svg/.pdf）
  dpi    可选，默认 200
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# DeepSeek 视觉惯例：中性灰蓝为底，只给「我们的」一条强调色
PALETTE = ["#8C9BAB", "#B9C2CC", "#D5DAE0", "#6E7F92", "#A7B3BF"]
ACCENT = "#2F5D8C"


def load_data(args: dict) -> dict:
    raw = args.get("data")
    if isinstance(raw, dict):
        return raw
    p = Path(str(raw))
    d = json.loads(p.read_text(encoding="utf-8"))
    return d.get("figure", d) if "figure" in d else d


def apply_style(plt, grid: str = "three-line") -> None:
    plt.rcParams.update({
        "font.size": 9,
        "font.family": "DejaVu Sans",
        "axes.edgecolor": "#333333",
        "axes.linewidth": 0.8,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": grid != "none",
        "grid.color": "#D8DDE3",
        "grid.linewidth": 0.6,
        "grid.linestyle": "-",
        "legend.frameon": False,
        "figure.dpi": 200,
        "savefig.bbox": "tight",
    })


def run(args: dict) -> dict:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return {"ok": False, "error": {"code": "E_NO_MPL",
                                       "message": "未安装 matplotlib；数据已校验，可先交付表格/文本"}}
    d = load_data(args)
    series = d.get("series") or []
    if not series:
        return {"ok": False, "error": {"code": "E_SHAPE", "message": "需要 series"}}
    kind = (d.get("type") or "bar").lower()
    style = d.get("style") or {}
    apply_style(plt, style.get("grid", "three-line"))
    out = Path(args["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(float(style.get("width", 7.0)),
                                    float(style.get("height", 2.6))))
    cats = d.get("categories") or []
    hi_first = [s for s in series if s.get("highlight")]
    normal = [s for s in series if not s.get("highlight")]

    if kind == "bar":
        n = len(series)
        width = 0.8 / max(n, 1)
        for i, s in enumerate(normal + hi_first):
            xs = [j + (i - (n - 1) / 2) * width for j in range(len(cats))]
            color = ACCENT if s.get("highlight") else PALETTE[i % len(PALETTE)]
            bars = ax.bar(xs, s["values"], width * 0.92, label=s.get("name", f"s{i}"),
                          color=color, edgecolor="none")
            if style.get("value_labels"):
                for b in bars:
                    ax.annotate(f"{b.get_height():g}", (b.get_x() + b.get_width() / 2,
                                b.get_height()), ha="center", va="bottom",
                                fontsize=6.5, color="#333333")
        ax.set_xticks(range(len(cats)))
        ax.set_xticklabels(cats, rotation=float(style.get("rotate", 20)), ha="right")

    elif kind in ("line", "scaling"):
        xs = d.get("x_values") or list(range(len(series[0]["values"])))
        for i, s in enumerate(normal + hi_first):
            color = ACCENT if s.get("highlight") else PALETTE[i % len(PALETTE)]
            ax.plot(xs, s["values"], marker=style.get("marker", "o"), ms=3,
                    lw=1.6 if s.get("highlight") else 1.1, color=color,
                    label=s.get("name", f"s{i}"))
        if kind == "scaling":
            fit = d.get("fit") or {}
            if fit.get("exclude") is not None and fit.get("fit_x") and fit.get("fit_y"):
                fx, fy = fit["fit_x"], fit["fit_y"]
                n = len(fx)
                sx, sy = sum(fx), sum(fy)
                sxx = sum(v * v for v in fx)
                sxy = sum(a * b for a, b in zip(fx, fy))
                denom = n * sxx - sx * sx
                if denom:
                    k = (n * sxy - sx * sy) / denom
                    b = (sy - k * sx) / n
                    ax.plot(fx, [k * v + b for v in fx], ls="--", lw=1.0, color="#C0504D",
                            label=fit.get("label", "linear fit"))

    ax.set_ylabel(d.get("y_label", ""))
    if d.get("x_label"):
        ax.set_xlabel(d["x_label"])
    if style.get("legend", "bottom") == "bottom":
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.28),
                  ncol=min(len(series), 5), fontsize=7.5)
    else:
        ax.legend(loc=style["legend"], fontsize=7.5)
    fig.savefig(out, dpi=int(args.get("dpi", 200)))
    plt.close(fig)
    cap = d.get("caption", "")
    return {
        "ok": True,
        "result": {
            "written": str(out),
            "type": kind,
            "series": [s.get("name") for s in series],
            "caption": cap,
            "caption_sentences": len([x for x in cap.replace("!", ".").replace("?", ".").split(".") if x.strip()]),
            "hint": "caption 需 ≥2 句（是什么 + 怎么测 + 一句结论），并在正文引用本图" if cap else "缺 caption",
        },
    }


def main() -> int:
    raw = sys.stdin.read()
    try:
        args = (json.loads(raw) if raw.strip() else {}).get("args") or {}
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": {"code": "E_BAD_INPUT", "message": str(exc)}}))
        return 2
    if not args.get("data") or not args.get("out"):
        print(json.dumps({"ok": False, "error": {"code": "E_ARGS", "message": "需要 args.data 与 args.out"}}))
        return 2
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": {"code": "E_RUNTIME", "message": str(exc)}},
                         ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
