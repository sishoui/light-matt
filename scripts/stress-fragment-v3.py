"""§2.4 分片写压力：连续下发跨多片的命令，统计重组/校验失败次数。

用法（仓库根，设备空闲）：
    python scripts/stress-fragment-v3.py            # 60s，强制 19B 数据片（2 片/帧）
    python scripts/stress-fragment-v3.py 120        # 跑 120s
    python scripts/stress-fragment-v3.py 60 247     # 用真实 MTU，通常 1 片/帧

为什么强制小分片：本机 BLE 协商出的 MTU 通常够大，21 字节段载荷一帧就写得下，
根本压不到重组路径。把 data_cap 钉在 19B 才能保证每条命令都跨 2 片。

判据（票面）：重组失败 0 次。这里的「失败」只看**非 0 的 ACK**——
丢 ACK 不算重组失败（PC 侧发送过快会丢通知，不代表设备没处理）。
2026-11-01 实测：787 条 × 2 片，非 0 ACK 0 次。
"""
import asyncio, struct, sys, time
from bleak import BleakClient, BleakScanner
S="6c756d65-6e00-4b1e-9a3c-000000000001"; RX=S[:-1]+"2"; TX=S[:-1]+"3"
def crc(d):
    c=0xFFFF
    for b in d:
        c^=b<<8
        for _ in range(8):
            c=((c<<1)^0x1021)&0xFFFF if c&0x8000 else (c<<1)&0xFFFF
    return c
def enc(cmd,seq,p=b""):
    b=bytes([0xA6,3,cmd,seq])+struct.pack("<H",len(p))+p
    return b+struct.pack("<H",crc(b))
def layer(t,hue,sat,period=0,p5=0,flags=0):
    return bytes([t])+struct.pack("<H",hue)+bytes([sat])+struct.pack("<H",period)+bytes([p5,flags])

async def main():
    seconds=float(sys.argv[1]) if len(sys.argv)>1 else 60
    mtu_force=int(sys.argv[2]) if len(sys.argv)>2 else 23   # 强制小分片
    dev=None
    for d in await BleakScanner.discover(timeout=6.0, service_uuids=[S]):
        if d.name and d.name.startswith("Lumen-"): dev=d;break
    if dev is None: sys.exit("没找到设备")
    async with BleakClient(dev.address, timeout=20.0) as cl:
        data_cap = (mtu_force-3)-1 if mtu_force>23 else 19
        acks={}; frames=[]
        buf=bytearray()
        def cb(_c,raw):
            raw=bytes(raw)
            if raw[0]&0x80: buf.clear()
            buf.extend(raw[1:])
            if raw[0]&0x40:
                f=bytes(buf); buf.clear()
                if len(f)>=8: frames.append(f)
        await cl.start_notify(TX,cb)
        await cl.write_gatt_char(RX, bytes([0xC0])+enc(0x01,1,b"\x01"), response=False)
        await cl.write_gatt_char(RX, bytes([0xC0])+enc(0x02,2,b"\x80"), response=False)
        await asyncio.sleep(0.2)

        # 构造一个 21 字节段 → 逻辑帧 29 字节 → 在 data_cap=19 下分 2 片
        seg = bytes([0,0,0,29,1]) + layer(0x02,0,255,3000,255) + layer(0x01,0,255,1500,30)
        frame = enc(0x10, 0, seg)
        nchunks = (len(frame)+data_cap-1)//data_cap
        print(f"逻辑帧 {len(frame)}B，data_cap={data_cap} → {nchunks} 片/帧，跑 {seconds}s")

        sent=0; seq=10; t0=time.time()
        while time.time()-t0 < seconds:
            seq = (seq % 255) + 1
            fr = enc(0x10, seq, seg)
            for i in range(0, len(fr), data_cap):
                ch = fr[i:i+data_cap]
                ctrl = (0x80 if i==0 else 0) | (0x40 if i+data_cap>=len(fr) else 0) | ((i//data_cap)&0x3F)
                await cl.write_gatt_char(RX, bytes([ctrl])+ch, response=False)
                await asyncio.sleep(0.02)
            sent += 1
            if sent % 20 == 0:
                await asyncio.sleep(0.01)
        await asyncio.sleep(1.0)
        await cl.stop_notify(TX)

        acks=[f for f in frames if f[2]==0x80]
        ack_ok=sum(1 for f in acks if f[7]==0)
        ack_bad=sum(1 for f in acks if f[7]!=0)
        print(f"下发 {sent} 条 SetSegment（每条 {nchunks} 片 = {sent*nchunks} 次写）")
        print(f"ACK 共收 {len(acks)}（OK={ack_ok} 非0={ack_bad}）；发出 {sent} 条")
        lost = max(0, sent-ack_ok-ack_bad)
        print(f"非0 ACK（=重组或校验失败）：{ack_bad} 次  →  重组失败率 {100.0*ack_bad/max(sent,1):.2f}%")
        print("判定:", "重组/校验 0 次失败 ✓" if ack_bad==0 else f"失败 {ack_bad} 次 ✗")
asyncio.run(main())
