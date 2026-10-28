"""本地测试用的密钥注入替身：测试代码用 set_tool_credentials() 设定本次「注入」的凭证。"""
_CREDS = None


def set_tool_credentials(values):
    global _CREDS
    _CREDS = dict(values) if values else None


def get_tool_credentials():
    return dict(_CREDS) if _CREDS else None
