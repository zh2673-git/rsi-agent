"""Qwen3-TTS 常驻合成进程：模型只加载一次，按行读 JSON 请求逐句合成。

用法：python qwen3_tts_worker.py <模型目录>
请求：{"id":1,"text":"旁白","out":"输出 wav","ref_audio":"参考音频","ref_text":"参考逐字稿"}
应答：{"id":1,"ok":true} 或 {"id":1,"ok":false,"error":"..."}
"""
import json
import sys

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL = sys.argv[1]
LANG = sys.argv[2] if len(sys.argv) > 2 else "Chinese"

print(json.dumps({"ready": False, "stage": "loading"}), flush=True)
model = Qwen3TTSModel.from_pretrained(MODEL, device_map="cuda:0", dtype=torch.bfloat16)
prompts = {}
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
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
