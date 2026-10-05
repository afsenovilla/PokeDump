#!/usr/bin/env python3
"""Write vectors.json for run.mjs from the Python framing in firmware/tools/host_bridge.py,
which has carried real sessions. Payload lengths sit on both sides of the COBS block
boundaries of the whole frame (16 bytes of header and CRC around the payload)."""
import importlib.util, json, random, struct, sys, types, zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.modules.setdefault("serial", types.ModuleType("serial"))     # only the framing is used
spec = importlib.util.spec_from_file_location("host_bridge", HERE.parents[1] / "firmware" / "tools" / "host_bridge.py")
host_bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_bridge)

random.seed(7)
vectors = []
for length in [0, 1, 2, 5, 64, 237, 238, 239, 240, 253, 254, 255, 491, 492, 493, 494]:
    for fill in ("random", "zeros", "no zeros"):
        if fill == "zeros" and length > 300:
            continue
        payload = (bytes(length) if fill == "zeros" else
                   bytes(random.randrange(1 if fill == "no zeros" else 0, 256) for _ in range(length)))
        raw = struct.pack("<BBIIH", 1, 6, 0x11223344, 0xA1B2C3D4, length) + payload
        raw += struct.pack("<I", zlib.crc32(raw) & 0xFFFFFFFF)
        vectors.append({"payload": payload.hex(), "crc": zlib.crc32(payload) & 0xFFFFFFFF,
                        "frame": (host_bridge.cobs_encode(raw) + b"\x00").hex()})
(HERE / "vectors.json").write_text(json.dumps(vectors))
print(len(vectors), "vectors")
