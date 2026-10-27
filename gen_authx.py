# -*- coding: utf-8 -*-


import hashlib
import json
import random
import sys
import time
import urllib.parse
from urllib.parse import parse_qsl, urlparse

SECRET = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"               # bundle 硬编码盐
API_KEY = "16CCEB3D-AB42-077D-36A1-F355324E4237"       # bundle 内 XOR 解码


def md5_hex(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def gen_authx(method: str, url: str, body_json: str | None = None,
              nonce: int | None = None, timestamp_ms: int | None = None) -> str:
    method = method.upper()
    path = urlparse(url).path

    if method == "GET":
        # GET：查询参数按 key 排序 -> URL 编码(空格=%20) -> 反解后 md5
        params = parse_qsl(urlparse(url).query, keep_blank_values=True)
        params.sort(key=lambda kv: kv[0])
        qs = urllib.parse.urlencode(params).replace("+", "%20")
        body_hash = md5_hex(urllib.parse.unquote(qs))
    else:
        # 非 GET：body 重新紧凑序列化（与 JS JSON.stringify 逐字节一致）；无 body 时为空串
        if body_json is None or body_json.strip() == "":
            body_str = ""
        else:
            body_str = json.dumps(json.loads(body_json), separators=(",", ":"))
        body_hash = md5_hex(body_str)

    nonce = nonce if nonce is not None else random.randint(100000, 999999)
    timestamp_ms = timestamp_ms if timestamp_ms is not None else int(time.time() * 1000)
    sign = md5_hex(f"{SECRET}_{path}_{nonce}_{timestamp_ms}_{body_hash}_{API_KEY}")
    return f"nonce={nonce}&timestamp={timestamp_ms}&sign={sign}"


