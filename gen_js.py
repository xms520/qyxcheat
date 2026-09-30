#!/usr/bin/env python3
# gen_js.py — 把 QYXY_inject.js 转成 C 字符串头文件 qyxy_js.h
# 逐字节十六进制数组，避免 C 字符串转义/拼接坑（历次工程铁律）
import sys, os

src = sys.argv[1] if len(sys.argv) > 1 else "QYXY_inject.js"
dst = sys.argv[2] if len(sys.argv) > 2 else "qyxy_js.h"

data = open(src, "rb").read()
out = []
out.append("// 自动生成，请勿手改。源: %s  size=%d" % (os.path.basename(src), len(data)))
out.append("static const char QYXY_JS[] = {")
for i in range(0, len(data), 24):
    chunk = data[i:i+24]
    out.append("    " + "".join("0x%02x," % b for b in chunk))
out.append("    0x00")
out.append("};")
open(dst, "w").write("\n".join(out) + "\n")
print("wrote %s  (%d bytes source -> %d lines)" % (dst, len(data), len(out)))
