""""
SOTA Browser MCP Server — Configuration Constants
"""

DEFAULT_VIEWPORT = {"width": 1280, "height": 720}
DEFAULT_TIMEOUT = 15000  # 15s
FAST_WAIT = 0.1
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
)

MCP_PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "sota-browser"
SERVER_VERSION = "1.7.0"  # CloakBrowser integration + proxy rotation

# Retry defaults
RETRY_MAX_ATTEMPTS = 3
RETRY_BASE_DELAY_MS = 500
RETRY_MAX_DELAY_MS = 10000
RETRY_JITTER = 0.3

# Circuit breaker defaults
CB_FAILURE_THRESHOLD = 5
CB_RECOVERY_TIMEOUT_S = 30

# Semantic cache defaults
CACHE_TTL_SNAPSHOT_S = 300  # 5 min
CACHE_TTL_HTTP_S = 3600    # 1 hr
CACHE_SIMILARITY_THRESHOLD = 0.7

# Memory defaults
MEMORY_MAX_ACTIONS = 200

# Nopecha CAPTCHA defaults
NOPECHA_API_URL = "https://api.nopecha.com/v1"
NOPECHA_SOLVE_TIMEOUT_S = 60  # Max wait for CAPTCHA solution
NOPECHA_POLL_INTERVAL_S = 3  # Poll interval when waiting for solution
