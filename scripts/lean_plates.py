"""生成靠边动作的绿幕关键帧（首帧 / 尾帧），供 MiniMax-H3 图生视频使用。

首帧 = 从既有待机素材「待机呼吸休闲」抽一帧标准正面站立，合成到纯绿幕画布；
尾帧 = 「靠边-开始」的末帧（扒边探头的靠边姿态），同样合成到绿幕。

为什么不用 assets/main-character.png：那张是平面设定图（RGB、无 alpha、白底），
白荷叶边围裙与白背景同色，抠不出干净边缘；既有动画帧是已经渲好的同一角色，
造型、配色、描边与库内其它动作完全一致，直接拿来当关键帧才是真正的「保持原型」。

抠像边处理：先做 alpha choke（把半透明边缘往里收 25%），再合成到绿幕，
这样边缘像素是纯绿而不是「角色色 + 绿」的混色，后续 HSV 抠像能干净地抠掉，
不会在成品上留一圈绿边。

用法：
  python scripts/lean_plates.py --src assets/webm/待机呼吸休闲.webm --frame 0 --out work/lean-plate-standing.png
  python scripts/lean_plates.py --src step02/靠边-开始.webm --last --out work/lean-plate-lean.png
  python scripts/lean_plates.py --src work/lean-plate-lean.png --align-ref work/lean-plate-standing.png --out work/lean-plate-lean-aligned.png
  # 左侧版：镜像 + 按左缘对齐（手的落点对齐到站立剪影的左缘）
  python scripts/lean_plates.py --src work/lean-plate-lean-aligned.png --mirror --align-ref work/lean-plate-standing.png --align-side left --out work/lean-plate-lean-left.png

--align-ref：把源图里的角色整体平移，直到「角色对齐边」与「参考图的对齐边」落在画幅的同一横向比例上。
靠边动作要扒住的那条竖线就是手（角色最外点）；若手比站立剪影的外缘还靠里，
运行时只能把整只宠物按身体的外缘贴到屏幕边线，手就够不着边了——先对齐再生成，
三段才落在同一个位置上。--align-side 决定用哪条边（右侧版用 right，左侧版用 left）。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")
FFPROBE = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffprobe.exe")

# 绿幕底色：与库内素材链的 Chroma Key Green 一致（#00FF00）。
GREEN = (0, 255, 0)
# alpha choke 的起止点：a <= 40 全透明，a >= 165 全不透明，中间线性过渡。
CHOKE_LO = 40.0
CHOKE_HI = 165.0


def probe_size(video: Path) -> tuple[int, int]:
    """读视频的宽高（px）。"""
    cmd = [
        FFPROBE, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(video),
    ]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8").stdout.strip()
    w, h = out.split("x")[:2]
    return int(w), int(h)


def read_frame(video: Path, frame: int | None, last: bool) -> np.ndarray:
    """抽一帧，返回 H×W×4 的 RGBA 数组。

    frame 给定时抽该帧；last=True 时抽末帧（用 -sseof 定位，避免整段解码）。
    """
    width, height = probe_size(video)
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
    # VP9-alpha 的 webm 必须显式指定 libvpx 解码器（默认解码器会丢 alpha 通道）；
    # 其它容器（H.264 的 mp4 等）用默认解码器，写死 libvpx 会直接解不出来。
    if video.suffix.lower() == ".webm":
        cmd += ["-c:v", "libvpx-vp9"]
    if last:
        cmd += ["-sseof", "-0.15"]
    cmd += ["-i", str(video)]
    if not last:
        cmd += ["-vf", f"select=eq(n\\,{frame})"]
    cmd += ["-fps_mode", "passthrough", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    if len(raw) < width * height * 4:
        raise RuntimeError(f"frame read failed: {video.name} (got {len(raw)} bytes)")
    return np.frombuffer(raw, np.uint8).reshape(height, width, 4)


def to_green_plate(rgba: np.ndarray) -> np.ndarray:
    """把 RGBA 帧合成到纯绿画布（先 choke 再合成，边缘是纯绿不是混色）。"""
    alpha = rgba[..., 3].astype(np.float32)
    choked = np.clip((alpha - CHOKE_LO) / (CHOKE_HI - CHOKE_LO), 0.0, 1.0)
    fg = rgba[..., :3].astype(np.float32)
    bg = np.array(GREEN, dtype=np.float32)
    a = choked[..., None]
    return np.clip(fg * a + bg * (1.0 - a), 0, 255).astype(np.uint8)


def write_png(rgb: np.ndarray, out: Path) -> None:
    """写 PNG（RGB）。"""
    from PIL import Image

    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, "RGB").save(out)


def foreground_mask(rgb: np.ndarray) -> np.ndarray:
    """绿幕判定：色相在绿色区间且饱和/明度达标的就是背景，其余是角色。"""
    r = rgb[..., 0].astype(np.float32) / 255.0
    g = rgb[..., 1].astype(np.float32) / 255.0
    b = rgb[..., 2].astype(np.float32) / 255.0
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    delta = mx - mn
    hue = np.zeros_like(mx)
    nz = delta > 0
    with np.errstate(divide="ignore", invalid="ignore"):
        hr = 60.0 * (((g - b) / np.where(nz, delta, 1)) % 6.0)
        hg = 60.0 * (((b - r) / np.where(nz, delta, 1)) + 2.0)
        hb = 60.0 * (((r - g) / np.where(nz, delta, 1)) + 4.0)
    hue = np.where((mx == r) & nz, hr, np.where((mx == g) & nz, hg, np.where((mx == b) & nz, hb, 0.0)))
    sat = np.where(mx > 0, delta / np.maximum(mx, 1e-6), 0.0)
    is_bg = (hue >= 70.0) & (hue <= 170.0) & (sat >= 0.15) & (mx >= 0.15)
    return ~is_bg


def rightmost_fraction(rgb: np.ndarray) -> float:
    """角色最右像素落在画幅的哪个横向比例（0~1）。"""
    fg = foreground_mask(rgb)
    xs = np.where(fg.any(axis=0))[0]
    if len(xs) == 0:
        raise RuntimeError("no foreground pixels found")
    return float(xs.max()) / rgb.shape[1]


def leftmost_fraction(rgb: np.ndarray) -> float:
    """角色最左像素落在画幅的哪个横向比例（0~1）。"""
    fg = foreground_mask(rgb)
    xs = np.where(fg.any(axis=0))[0]
    if len(xs) == 0:
        raise RuntimeError("no foreground pixels found")
    return float(xs.min()) / rgb.shape[1]


def shift_horizontal(rgb: np.ndarray, shift_px: int) -> np.ndarray:
    """把角色整体水平平移 shift_px 像素（正数右移、负数左移），背景仍是纯绿。"""
    if shift_px == 0:
        return rgb
    height, width, _ = rgb.shape
    out = np.empty_like(rgb)
    out[..., 0], out[..., 1], out[..., 2] = GREEN
    ys, xs = np.where(foreground_mask(rgb))
    out[ys, np.clip(xs + shift_px, 0, width - 1)] = rgb[ys, xs]
    return out


def mirror_horizontal(rgb: np.ndarray) -> np.ndarray:
    """水平镜像（左右翻转）。"""
    return np.ascontiguousarray(rgb[:, ::-1, :])


def read_png(path: Path) -> np.ndarray:
    """读 PNG（RGB），返回 H×W×3。"""
    from PIL import Image

    with Image.open(path) as img:
        return np.array(img.convert("RGB"), dtype=np.uint8)


def load_source(path: Path, frame: int | None, last: bool) -> np.ndarray:
    """源可以是视频（抽帧）或 PNG（直接读），统一返回 RGB 数组。"""
    if path.suffix.lower() == ".png":
        return read_png(path)
    return to_green_plate(read_frame(path, frame, last))


def main() -> int:
    parser = argparse.ArgumentParser(description="生成靠边动作的绿幕关键帧")
    parser.add_argument("--src", required=True, help="源视频（webm）或 PNG")
    parser.add_argument("--frame", type=int, default=0, help="抽第几帧（0 起）")
    parser.add_argument("--last", action="store_true", help="抽末帧")
    parser.add_argument("--align-ref", help="参考图：角色的对齐边要与之落在画幅的同一横向比例上")
    parser.add_argument(
        "--align-side",
        choices=("right", "left"),
        default="right",
        help="对齐哪一侧：right=角色最右像素对齐参考图最右像素（往右侧靠边）；left=反之（往左侧靠边）",
    )
    parser.add_argument("--mirror", action="store_true", help="源图水平镜像（做左侧版关键帧用）")
    parser.add_argument("--out", required=True, help="输出 PNG 路径")
    args = parser.parse_args()

    src = Path(args.src)
    if not src.is_absolute():
        src = ROOT / src
    out = Path(args.out)
    if not out.is_absolute():
        out = ROOT / out

    rgb = load_source(src, args.frame, args.last)
    if args.mirror:
        rgb = mirror_horizontal(rgb)
    if args.align_ref:
        ref = Path(args.align_ref)
        if not ref.is_absolute():
            ref = ROOT / ref
        edge = leftmost_fraction if args.align_side == "left" else rightmost_fraction
        ref_frac = edge(load_source(ref, args.frame, args.last))
        src_frac = edge(rgb)
        shift_px = round((ref_frac - src_frac) * rgb.shape[1])
        print(f"align[{args.align_side}]: ref_x={ref_frac:.4f} src_x={src_frac:.4f} shift={shift_px}px")
        rgb = shift_horizontal(rgb, shift_px)
    write_png(rgb, out)
    print(f"plate written: {out} ({rgb.shape[1]}x{rgb.shape[0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
