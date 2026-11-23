"""Unify character size across step02 videos into step03.

整帧等比缩放 + overlay 平移到 2160x1215（16:9）透明画布：
- 站立高度 900（按首尾站立帧的平均高度计算缩放比例）
- 水平居中，脚底对齐（按全帧内容最低点对齐，保证动画不裁剪）
- 不裁剪人物/动作内容，底部超出的透明空白直接裁掉
- 画布 2160x1215 与原始视频同为 16:9，宽度容纳最宽动作（2015px）

「靠边」系列（首尾姿态不同的动作）走 scripts/normalize_overrides.json 覆盖：
默认拿首尾两端的帧一起量站立基准，而「靠边-开始」尾帧是扒边姿态、「靠边-循环」整段都是扒边姿态，
量出来的基准会歪（角色被拉回画幅中间、手也就抓不到边缘）。覆盖项让这几段统一用
「靠边-开始」首帧那套站立基准，缩放与水平落位三段完全一致，段与段之间才不会跳位。
"""

from __future__ import annotations

import json
import re
import subprocess
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "step02"
OUT = ROOT / "step03"
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")
FFPROBE = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffprobe.exe")

PARALLEL = 4
CANVAS_W = 2160  # 16:9：2160 = 1215 * 16/9，与原始视频同比例
CANVAS_H = 1215
TARGET_HEIGHT = 900
FEET_Y = CANVAS_H - 100  # 距底 100

SRC_W = 1280
SRC_H = 720
FPS = 24
HEAD_FRAMES = 5
TAIL_SEEK = -0.2  # 从末尾取帧，避免取到收尾动作
# 站立基准的逐素材覆盖项（见模块头）：靠边系列用它对齐三段的落位。
OVERRIDES = Path(__file__).resolve().parent / "normalize_overrides.json"

_BBOX_RE = re.compile(r"x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)")


def scan_bbox(video: Path, seek: float | None = None, frames: int | None = None) -> list[tuple[int, int, int, int]]:
    """用 alphaextract,bbox 滤镜扫描帧内容边界，返回 [(x1, x2, y1, y2)] 列表。"""
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "info", "-c:v", "libvpx-vp9"]
    if seek is not None:
        cmd += ["-sseof", str(seek)]
    cmd += ["-i", str(video)]
    if frames is not None:
        cmd += ["-frames:v", str(frames)]
    cmd += ["-vf", "alphaextract,bbox", "-f", "null", "-"]
    # text=True 时显式指定 UTF-8 解码（Windows 默认 GBK 会解不了 ffmpeg 的 UTF-8 输出）
    result = subprocess.run(cmd, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return [tuple(int(g) for g in m.groups()) for m in _BBOX_RE.finditer(result.stderr)]


def read_alpha_frames(video: Path, seek: float | None = None, frames: int | None = None) -> list[np.ndarray]:
    """解码指定帧的 alpha 通道（每帧 H×W uint8 数组）。"""
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9"]
    if seek is not None:
        cmd += ["-sseof", str(seek)]
    cmd += ["-i", str(video)]
    if frames is not None:
        cmd += ["-frames:v", str(frames)]
    cmd += ["-f", "rawvideo", "-pix_fmt", "rgba", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    frame_size = SRC_W * SRC_H * 4
    out: list[np.ndarray] = []
    while True:
        buf = b""
        while len(buf) < frame_size:
            chunk = p.stdout.read(frame_size - len(buf))
            if not chunk:
                break
            buf += chunk
        if len(buf) < frame_size:
            break
        out.append(np.frombuffer(buf, np.uint8).reshape(SRC_H, SRC_W, 4)[..., 3])
    p.stdout.close()
    p.wait()
    return out


def measure_standing(video: Path, mode: str = "head-tail") -> dict:
    """站立姿态的测量基准。

    mode:
      head-tail（默认）——首尾各 HEAD_FRAMES 帧一起算（库内绝大多数动作首尾都是站立）
      head / tail——只取首侧或尾侧那一段（首尾姿态不同的动作用，比如「靠边」系列）

    水平中心用非透明像素 x 的中位数（防手/零食等扩展物把 bbox 中心拉偏），
    垂直基准用 bbox（y 方向扩展物干扰小，bbox 本身可靠）。
    """
    alphas: list[np.ndarray] = []
    if mode in ("head-tail", "head"):
        alphas += read_alpha_frames(video, frames=HEAD_FRAMES)
    if mode in ("head-tail", "tail"):
        alphas += read_alpha_frames(video, seek=TAIL_SEEK, frames=HEAD_FRAMES)
    med_xs, heights, max_ys = [], [], []
    for a in alphas:
        ys, xs = np.where(a > 10)
        if len(xs) == 0:
            continue
        med_xs.append(float(np.median(xs)))
        heights.append(int(ys.max() - ys.min() + 1))
        max_ys.append(int(ys.max()))
    if not med_xs:
        raise RuntimeError(f"No opaque pixels found in {video.name}")
    return {
        "height": sum(heights) / len(heights),
        "max_y": sum(max_ys) / len(max_ys),
        "center_x": sum(med_xs) / len(med_xs),
    }


def measure_content_union(video: Path) -> tuple[int, int, int, int]:
    """全帧扫描内容范围并集 (x1, y1, x2, y2)，用于校验动画内容是否被裁。"""
    boxes = scan_bbox(video)
    if not boxes:
        raise RuntimeError(f"No opaque pixels found in {video.name}")
    return (
        min(b[0] for b in boxes),
        min(b[2] for b in boxes),
        max(b[1] for b in boxes),
        max(b[3] for b in boxes),
    )


def build_filter(scale: float, standing: dict, center_x: float) -> str:
    """整帧缩放 + overlay 平移到透明画布，站立水平居中、脚底对齐 FEET_Y。

    center_x 单独传进来：靠边系列的水平基准来自覆盖项（另一个素材量出来的站立中心），
    不能用本段自己量出来的尾帧中位数。
    """
    scaled_w = int(SRC_W * scale) // 2 * 2
    scaled_h = int(SRC_H * scale) // 2 * 2
    overlay_x = CANVAS_W / 2 - center_x * scale
    overlay_y = FEET_Y - standing["max_y"] * scale
    return (
        f"color=c=black@0:s={CANVAS_W}x{CANVAS_H}:r={FPS}[bg];"
        f"[0:v]scale={scaled_w}:{scaled_h}[sc];"
        f"[bg][sc]overlay={overlay_x:.1f}:{overlay_y:.1f}:shortest=1,format=yuva420p[v]"
    )


def convert_video(src: Path, dst: Path, filter_complex: str) -> None:
    cmd = [
        FFMPEG,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-c:v",
        "libvpx-vp9",  # 关键：libvpx 解码才能保留 VP9 alpha
        "-i",
        str(src),
        "-filter_complex",
        filter_complex,
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "30",
        "-b:v",
        "0",
        "-auto-alt-ref",
        "0",
        "-deadline",
        "good",
        "-cpu-used",
        "4",
        "-c:a",
        "libopus",
        "-b:a",
        "128k",
        str(dst),
    ]
    result = subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())


def _is_valid(dst: Path, src: Path, min_size: int = 50_000) -> bool:
    """断点续跑完整性检查：存在、够大、不比源旧、且能被 ffprobe 读到视频流。"""
    if not dst.exists() or dst.stat().st_size <= min_size:
        return False
    if dst.stat().st_mtime < src.stat().st_mtime:
        return False
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_name",
                        "-of", "csv=p=0", str(dst)], capture_output=True)
    return bool(r.stdout.strip())


def load_overrides() -> dict[str, dict]:
    """读 scripts/normalize_overrides.json：按素材名覆盖「站立基准」的取法。

    键是素材名（不含扩展名），值支持这些字段：
      measure   —— "head" | "tail" | "head-tail"，取哪一侧的帧当站立基准（默认 head-tail）
      reference —— 另一个素材名，整段都用那个素材量出来的缩放与水平基准（跨素材对齐用）
      scale     —— 直接指定缩放系数（覆盖按站立高度算出来的值）
      center_x  —— 直接指定水平基准像素（覆盖量出来的中位数）
    """
    if not OVERRIDES.exists():
        return {}
    return json.loads(OVERRIDES.read_text(encoding="utf-8"))


def _process_one(video: Path, overrides: dict[str, dict]) -> tuple[dict, bool]:
    """处理单个视频（worker 函数）：测量 + 转码（或跳过转码），返回 entry。

    注意：entry 必须可 JSON 序列化（params.json 由主进程汇总写入）。
    """
    dst = OUT / (video.stem + ".webm")
    # 断点续跑：完整输出已存在 → 跳过转码（但仍测量，保证 params.json 完整）
    skip = _is_valid(dst, video)
    ov = overrides.get(video.stem, {})
    mode = ov.get("measure", "head-tail")
    # reference：整段用另一个素材的站立基准——「靠边」三段要与「靠边-开始」同一落位，
    # 否则段与段之间会跳位（靠边-循环整段都是扒边姿态，自己量出来的基准是歪的）。
    ref_name = ov.get("reference")
    if ref_name:
        ref_video = SRC / f"{ref_name}.webm"
        if ref_video.exists():
            standing = measure_standing(ref_video, mode)
        else:
            # 参考素材缺失就退回自己量：落位会歪，但宁可让日志报出来，也不要整批崩掉。
            print(f"[WARN] {video.name}: reference '{ref_name}' not found, measuring itself", flush=True)
            standing = measure_standing(video, mode)
    else:
        standing = measure_standing(video, mode)
    union = measure_content_union(video)
    scale = float(ov.get("scale", TARGET_HEIGHT / standing["height"]))
    center_x = float(ov.get("center_x", standing["center_x"]))
    entry = {
        "file": video.name,
        "standing": {k: round(v, 1) for k, v in standing.items()},
        "content_union": {"x1": union[0], "y1": union[1], "x2": union[2], "y2": union[3]},
        "scale": round(scale, 6),
    }
    if not skip:
        filter_complex = build_filter(scale, standing, center_x)
        convert_video(video, dst, filter_complex)
    return entry, skip


def main() -> int:
    OUT.mkdir(exist_ok=True)
    videos = sorted(SRC.glob("*.webm"))
    if not videos:
        print(f"No WebM files found in {SRC}")
        return 1

    payload = {"canvas": f"{CANVAS_W}x{CANVAS_H}", "target_height": TARGET_HEIGHT, "feet_y": FEET_Y, "videos": []}
    total = len(videos)
    overrides = load_overrides()
    with ProcessPoolExecutor(max_workers=PARALLEL) as ex:
        for index, (entry, skip) in enumerate(ex.map(_process_one, videos, [overrides] * total), start=1):
            payload["videos"].append(entry)
            status = "SKIP" if skip else "OK"
            print(f"[{index}/{total}] {entry['file']} {status} (scale={entry['scale']})", flush=True)

    (OUT / "params.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Done. {total} videos written to {OUT} (parallel={PARALLEL})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
