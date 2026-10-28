"""Nexus 之外的「密钥注入」：S3 Vectors 凭证按顺序取
  1. KB_S3V_CREDENTIALS_FILE 指向的 JSON 文件（{"access_key_id": …, "secret_access_key": …}，文件权限 600）；
  2. 本进程的 AWS 默认凭证链（实例角色、AWS_PROFILE 等），取当时的临时凭证。
不打印、不缓存到磁盘。
"""
import json
import os


def get_tool_credentials():
    path = os.environ.get("KB_S3V_CREDENTIALS_FILE")
    if path:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return {k: d.get(k) for k in ("access_key_id", "secret_access_key", "session_token") if d.get(k)}
    import boto3
    creds = boto3.Session().get_credentials()
    if creds is None:
        return None
    c = creds.get_frozen_credentials()
    out = {"access_key_id": c.access_key, "secret_access_key": c.secret_key}
    if c.token:
        out["session_token"] = c.token
    return out
