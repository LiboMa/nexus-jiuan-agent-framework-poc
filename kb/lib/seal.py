"""一次性密钥对：让经 SSM 读回的机密在 SSM 命令历史里只留密文。

    python -I seal.py keygen <私钥文件>     生成 RSA-2048 私钥（600），stdout 输出公钥 PEM 的 base64（一行）
    python -I seal.py open <私钥文件>       stdin 读 base64 密文，stdout 输出明文（调用方重定向到 600 文件）

远端用 openssl 加密（OAEP，SHA-256），见 lib/common.sh 的 ssm_read_secret。私钥只存在于本次运行的
.build/secrets.<pid>/ 下，进程退出即删；SSM 的 StandardOutputContent 里只有密文，保留期内被人读到也没用。
"""
import base64
import os
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


def keygen(path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    pub = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    print(base64.b64encode(pub).decode())


def open_(path):
    with open(path, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    data = base64.b64decode("".join(sys.stdin.read().split()))
    pt = key.decrypt(data, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    sys.stdout.write(pt.decode("utf-8"))


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("keygen", "open"):
        sys.exit(__doc__)
    (keygen if sys.argv[1] == "keygen" else open_)(sys.argv[2])
