"""Qwen3-TTS 常驻合成进程：模型只加载一次，按行读 JSON 请求逐句合成。

用法：python qwen3_tts_worker.py <模型目录>
请求：{"id":1,"text":"旁白","out":"输出 wav","ref_audio":"参考音频","ref_text":"参考逐字稿"}
应答：{"id":1,"ok":true} 或 {"id":1,"ok":false,"error":"..."}

生命周期（P8-T0）：合成间隔超过空闲阈值（默认 300s，环境变量 MV_QWEN3_IDLE_EXIT 秒可覆盖）
自动退出释放显存；父进程死亡（stdin EOF）立即退出。正常批量合成不受影响——
计时器在每次收到请求时重置，只有「加载完模型却没人再派活」才会触发。
"""
import json
import os
import sys
import threading

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL = sys.argv[1]
LANG = sys.argv[2] if len(sys.argv) > 2 else "Chinese"

# 父进程用 Start-Process/后台重定向启动时 stdin 可能是 None（不是空流），
# 旧写法 `for line in sys.stdin` 会抛 TypeError 直接退出——表现为「配音莫名其妙停了」。
if sys.stdin is None:
    print(json.dumps({"ready": False, "fatal": "stdin 不可用（需由持有管道的父进程启动）"}), flush=True)
    sys.exit(2)


def _idle_seconds() -> float:
    try:
        v = float(os.environ.get("MV_QWEN3_IDLE_EXIT", "300"))
        return v if v > 0 else 300.0
    except ValueError:
        return 300.0


IDLE_EXIT = _idle_seconds()
# 收到请求时重置；到点且没有合成在跑就退出。守护线程，不阻塞主循环。
_timer: threading.Timer | None = None


def _arm_idle_timer() -> None:
    global _timer
    if _timer is not None:
        _timer.cancel()
    _timer = threading.Timer(IDLE_EXIT, _exit_idle)
    _timer.daemon = True
    _timer.start()


def _exit_idle() -> None:
    # 空闲退出是设计行为不是故障：0.6B 模型常驻会独占 GPU（实测 8188MiB），
    # 挂机脚本崩溃后父进程再也收不回这块显存。下次合成由 client 重新拉起 worker。
    print(json.dumps({"ready": False, "stage": "idle-exit", "after_sec": IDLE_EXIT}), flush=True)
    os._exit(0)


print(json.dumps({"ready": False, "stage": "loading"}), flush=True)
model = Qwen3TTSModel.from_pretrained(MODEL, device_map="cuda:0", dtype=torch.bfloat16)
prompts = {}
print(json.dumps({"ready": True, "idle_exit_sec": IDLE_EXIT}), flush=True)
_arm_idle_timer()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    # stdin EOF（父进程死亡/正常收尾）会自然退出 for 循环——这就是「父死即退」。
    _arm_idle_timer()
    req = json.loads(line)
    rid = req.get("id")
    try:
        key = (req["ref_audio"], req["ref_text"])
        if key not in prompts:
            prompts[key] = model.create_voice_clone_prompt(
                ref_audio=req["ref_audio"],
                ref_text=req["ref_text"],
                x_vector_only_mode=False,
            )
        wavs, sr = model.generate_voice_clone(
            text=req["text"], language=req.get("lang", LANG), voice_clone_prompt=prompts[key]
        )
        sf.write(req["out"], wavs[0], sr)
        print(json.dumps({"id": rid, "ok": True}), flush=True)
    except Exception as e:  # 单句失败不拖垮常驻进程
        print(json.dumps({"id": rid, "ok": False, "error": str(e)}), flush=True)
