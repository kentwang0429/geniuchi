import os
import re
import subprocess
import sys
from typing import List, Optional

# =========================
# CONFIG
# =========================

# ✅ 日文男聲（口音日系）
VOICE = "ja-JP-KeitaNeural"

# ✅ LO 長、GAN 短（前面拖、後面短促）
# - 「ローォォォ」= LO 拉長
# - 「…」= 停頓一點（讓前段更像蓄力）
# - 「ガン！」= GAN 短促收尾
TEXT = "ローォォォ…ガン！"

# ✅ 生成底聲：不要太快（避免野獸化後變糊）
RATE = "-5%"
PITCH = "-10Hz"     # 底聲略降，後面野獸化會再大降
VOLUME = "+40%"

# ✅ 最終長度（你可以改 1.55~2.0）
TARGET_SEC = 2.0

# ✅ 輸出
OUT_DIR = os.path.join("public", "sfx")
OUT_TTS = os.path.join(OUT_DIR, "_logan_tts.mp3")
OUT_WAV = os.path.join(OUT_DIR, "_logan_fx.wav")
OUT_FINAL = os.path.join(OUT_DIR, "voice_logan.mp3")


# =========================
# HELPERS
# =========================

def run(cmd: List[str]) -> str:
    print(">> " + " ".join(cmd))
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise subprocess.CalledProcessError(p.returncode, cmd, output=p.stdout, stderr=p.stderr)
    return (p.stdout or "") + "\n" + (p.stderr or "")

def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)

def ffmpeg_max_volume_db(path: str) -> Optional[float]:
    txt = run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "volumedetect", "-f", "null", "-"])
    m = re.search(r"max_volume:\s*([-\d\.]+)\s*dB", txt)
    if not m:
        return None
    return float(m.group(1))


# =========================
# MAIN
# =========================

def main():
    ensure_dir(OUT_DIR)

    # 1) 先用 edge-tts 生成「日文口音」底聲
    #    ✅ 所有參數都用 --xxx=... 形式，避免負號被當成 option
    run([
        sys.executable, "-m", "edge_tts",
        "-v", VOICE,
        "-t", TEXT,
        f"--rate={RATE}",
        f"--pitch={PITCH}",
        f"--volume={VOLUME}",
        f"--write-media={OUT_TTS}",
    ])

    # 2) 野獸化 FX（核心）
    #
    # 目標：不像人類、低沉、粗、吼叫感
    # 主要手段：
    # - asetrate+atempo：大幅降音高但維持時長（不讓整段變太慢）
    # - bass/eq：加低頻厚度，削刺耳高頻
    # - acrusher：加粗糙顆粒（像野獸喉音）
    # - compand + acompressor：做出「貼臉、咆哮」的密度
    # - tremolo（輕微）：模擬喉音顫動（不要太重）
    #
    # 你想更不人類：把 PITCH_DOWN 變更大（例如 0.62）
    PITCH_DOWN = 0.68  # 越小越低沉（0.72~0.60 建議範圍）

    fx_chain = (
        # 基礎清理
        "highpass=f=70,"
        "lowpass=f=6500,"

        # ✅ 降音高（像野獸）
        # asetrate 降到 44100*PITCH_DOWN 會同時降 pitch 並變慢
        # atempo 用 1/PITCH_DOWN 把速度拉回來，讓長度大致保持
        f"asetrate=44100*{PITCH_DOWN},"
        f"atempo={1.0/PITCH_DOWN:.5f},"

        # ✅ 低頻厚度、削一點鼻音與刺耳
        "bass=g=8:f=120:w=0.6,"
        "equalizer=f=350:t=q:w=1.2:g=-3,"   # 減一點“人聲盒子感”
        "equalizer=f=2500:t=q:w=1.1:g=-4,"  # 削刺耳

        # ✅ 粗糙顆粒（更不像人類）
        "acrusher=bits=9:mix=0.28,"

        # ✅ 讓吼叫更密、更兇
        "compand=attacks=0.005:decays=0.12:points=-80/-80|-35/-18|-20/-10|0/-6,"
        "acompressor=threshold=-20dB:ratio=8:attack=6:release=90:knee=4:makeup=6dB,"

        # ✅ 輕微喉音顫動（不要太誇張）
        "tremolo=f=18:d=0.35,"

        # ✅ 最後保護：避免爆音
        "alimiter=limit=0.92"
    )

    # 先輸出 wav（方便後續裁切/淡出）
    run([
        "ffmpeg", "-y",
        "-i", OUT_TTS,
        "-af", fx_chain,
        "-ar", "44100",
        "-ac", "2",
        OUT_WAV
    ])

    # 3) 固定長度 + 尾端淡出（讓 GAN 短促收尾，不要拖太久）
    fade_dur = 0.22
    fade_start = max(0.0, TARGET_SEC - fade_dur)

    final_chain = (
        # 補靜音到足夠長再裁切
        "apad=pad_dur=3,"
        f"atrim=0:{TARGET_SEC},"
        f"afade=t=out:st={fade_start}:d={fade_dur}"
    )

    run([
        "ffmpeg", "-y",
        "-i", OUT_WAV,
        "-af", final_chain,
        "-t", str(TARGET_SEC),
        "-b:a", "192k",
        OUT_FINAL
    ])

    # 清理暫存
    for p in [OUT_TTS, OUT_WAV]:
        try:
            os.remove(p)
        except Exception:
            pass

    peak = ffmpeg_max_volume_db(OUT_FINAL)
    if peak is not None:
        print(f"✅ Done: {OUT_FINAL} (≈ {TARGET_SEC}s, peak {peak:.2f} dB)")
    else:
        print(f"✅ Done: {OUT_FINAL} (≈ {TARGET_SEC}s)")


if __name__ == "__main__":
    main()
