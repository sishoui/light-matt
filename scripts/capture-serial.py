#!/usr/bin/env python
"""抓一段 COM 口日志，用于真机联调时与小程序日志按 seq 对齐。

用法（在仓库根目录）：
    python scripts/capture-serial.py            # 默认 COM6，抓 30 秒
    python scripts/capture-serial.py COM6 60    # 抓 60 秒
    python scripts/capture-serial.py COM6 60 --reset   # 先复位再抓

为什么需要它：产品固件每帧只打一行 RX 汇总（cmd/seq/len/result/颜色），
小程序面板的 seq 同时显示十进制与十六进制，两边可以逐帧对上。
需要原始 hex 时把固件日志级别调到 DEBUG。

已知问题与规避：
- Windows 上 COM 口是独占的。上一次抓取进程没退出会一直占着口，
  报 "PermissionError(13)" 或 OSError(22) —— 本脚本会重试并提示。
  必要时手动清理：
      powershell -c "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\""
      powershell -c "Stop-Process -Id <pid> -Force"
- 微信开发者工具不占串口；占用通常是残留的 python 抓取进程。
"""

import sys
import time

try:
    import serial
except ImportError:
    sys.exit("需要 pyserial：python -m pip install pyserial")


def open_port(name, retries=8):
    for attempt in range(1, retries + 1):
        try:
            return serial.Serial(name, 115200, timeout=0.3)
        except Exception as exc:  # noqa: BLE001 - 端口错误类型因平台而异
            msg = str(exc).splitlines()[0]
            print(f"[capture] 打开 {name} 失败 ({attempt}/{retries}): {msg}")
            if attempt == retries:
                raise
            time.sleep(2)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    do_reset = "--reset" in sys.argv
    port = args[0] if len(args) > 0 else "COM6"
    seconds = float(args[1]) if len(args) > 1 else 30.0

    ser = open_port(port)
    if do_reset:
        # 原生 USB-JTAG 板上用 DTR/RTS 触发一次复位，便于抓完整启动日志。
        ser.setDTR(False)
        ser.setRTS(True)
        time.sleep(0.2)
        ser.setRTS(False)

    print(f"[capture] {port} 已打开，抓取 {seconds:.0f} 秒…按 Ctrl+C 提前结束")
    buf = b""
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            buf += ser.read(4096)
    except KeyboardInterrupt:
        print("\n[capture] 提前结束")
    finally:
        ser.close()

    text = buf.decode("utf-8", errors="replace")
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    print(f"--- {len(buf)} 字节 / {len(lines)} 行 ---")
    for ln in lines:
        print(ln)

    if not lines:
        print(
            "[capture] 没有任何输出。可能原因：\n"
            "  1. 设备没在跑（复位一次或重新烧录）\n"
            "  2. 端口不是这个（powershell -c \"[System.IO.Ports.SerialPort]::GetPortNames()\"）\n"
            "  3. 日志级别过高把 RX 汇总也过滤掉了（检查 CONFIG_LOG_DEFAULT_LEVEL）"
        )


if __name__ == "__main__":
    main()
